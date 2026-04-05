// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_PERSISTENT_NODE_H_
#define INCLUDE_CPPGC_INTERNAL_PERSISTENT_NODE_H_

#include <array>
#include <memory>
#include <vector>

#include "cppgc/internal/logging.h"
#include "cppgc/trace-trait.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {
namespace internal {

class CrossThreadPersistentRegion;
class FatalOutOfMemoryHandler;
class RootVisitor;

// PersistentNode represents a variant of two states:
// 1) traceable node with a back pointer to the Persistent object;
// 2) freelist entry.
class PersistentNode final {
 public:
  PersistentNode() = default;

  PersistentNode(const PersistentNode&) = delete;
  PersistentNode& operator=(const PersistentNode&) = delete;

  void InitializeAsUsedNode(void* owner, TraceRootCallback trace) {
    CPPGC_DCHECK(trace);
    owner_ = owner;
    trace_ = trace;
  }

  void InitializeAsFreeNode(PersistentNode* next) {
    next_ = next;
    trace_ = nullptr;
  }

  void UpdateOwner(void* owner) {
    CPPGC_DCHECK(IsUsed());
    owner_ = owner;
  }

  PersistentNode* FreeListNext() const {
    CPPGC_DCHECK(!IsUsed());
    return next_;
  }

  void Trace(RootVisitor& root_visitor) const {
    CPPGC_DCHECK(IsUsed());
    trace_(root_visitor, owner_);
  }

  bool IsUsed() const { return trace_; }

  void* owner() const {
    CPPGC_DCHECK(IsUsed());
    return owner_;
  }

 private:
  // PersistentNode acts as a designated union:
  // If trace_ != nullptr, owner_ points to the corresponding Persistent handle.
  // Otherwise, next_ points to the next freed PersistentNode.
  union {
    void* owner_ = nullptr;
    PersistentNode* next_;
  };
  TraceRootCallback trace_ = nullptr;
};

class V8_EXPORT PersistentRegionBase {
  using PersistentNodeSlots = std::array<PersistentNode, 256u>;

 public:
  // Clears Persistent fields to avoid stale pointers after heap teardown.
  ~PersistentRegionBase();

  PersistentRegionBase(const PersistentRegionBase&) = delete;
  PersistentRegionBase& operator=(const PersistentRegionBase&) = delete;

  void Iterate(RootVisitor&);

  size_t NodesInUse() const;

  void ClearAllUsedNodes();

 protected:
  explicit PersistentRegionBase(const FatalOutOfMemoryHandler& oom_handler);

  PersistentNode* TryAllocateNodeFromFreeList(void* owner,
                                              TraceRootCallback trace) {
    PersistentNode* node = nullptr;
    if (V8_LIKELY(free_list_head_)) {
      node = free_list_head_;
      free_list_head_ = free_list_head_->FreeListNext();
      CPPGC_DCHECK(!node->IsUsed());
      node->InitializeAsUsedNode(owner, trace);
      nodes_in_use_++;
    }
    return node;
  }

  void FreeNode(PersistentNode* node) {
    CPPGC_DCHECK(node);
    CPPGC_DCHECK(node->IsUsed());
    node->InitializeAsFreeNode(free_list_head_);
    free_list_head_ = node;
    CPPGC_DCHECK(nodes_in_use_ > 0);
    nodes_in_use_--;
  }

  PersistentNode* RefillFreeListAndAllocateNode(void* owner,
                                                TraceRootCallback trace);

 private:
  template <typename PersistentBaseClass>
  void ClearAllUsedNodes();

  void RefillFreeList();

  std::vector<std::unique_ptr<PersistentNodeSlots>> nodes_;
  PersistentNode* free_list_head_ = nullptr;
  size_t nodes_in_use_ = 0;
  const FatalOutOfMemoryHandler& oom_handler_;

  friend class CrossThreadPersistentRegion;
};

// Variant of PersistentRegionBase that checks whether the allocation and
// freeing happens only on the thread that created the region.
class V8_EXPORT PersistentRegion final : public PersistentRegionBase {
 public:
  explicit PersistentRegion(const FatalOutOfMemoryHandler&);
  // Clears Persistent fields to avoid stale pointers after heap teardown.
  ~PersistentRegion() = default;

  PersistentRegion(const PersistentRegion&) = delete;
  PersistentRegion& operator=(const PersistentRegion&) = delete;

  V8_INLINE PersistentNode* AllocateNode(void* owner, TraceRootCallback trace) {
    CPPGC_DCHECK(IsCreationThread());
    auto* node = TryAllocateNodeFromFreeList(owner, trace);
    if (V8_LIKELY(node)) return node;

    // Slow path allocation allows for checking thread correspondence.
    CPPGC_CHECK(IsCreationThread());
    return RefillFreeListAndAllocateNode(owner, trace);
  }

  V8_INLINE void FreeNode(PersistentNode* node) {
    CPPGC_DCHECK(IsCreationThread());
    PersistentRegionBase::FreeNode(node);
  }

 private:
  bool IsCreationThread();

  int creation_thread_id_;
};

// CrossThreadPersistent uses PersistentRegionBase but protects it using this
// lock when needed.
class V8_EXPORT PersistentRegionLock final {
 public:
  PersistentRegionLock();
  ~PersistentRegionLock();

  static void AssertLocked();
};

// Variant of PersistentRegionBase that checks whether the PersistentRegionLock
// is locked.
class V8_EXPORT CrossThreadPersistentRegion final
    : protected PersistentRegionBase {
 public:
  explicit CrossThreadPersistentRegion(const FatalOutOfMemoryHandler&);
  // Clears Persistent fields to avoid stale pointers after heap teardown.
  ~CrossThreadPersistentRegion();

  CrossThreadPersistentRegion(const CrossThreadPersistentRegion&) = delete;
  CrossThreadPersistentRegion& operator=(const CrossThreadPersistentRegion&) =
      delete;

  V8_INLINE PersistentNode* AllocateNode(void* owner, TraceRootCallback trace) {
    PersistentRegionLock::AssertLocked();
    auto* node = TryAllocateNodeFromFreeList(owner, trace);
    if (V8_LIKELY(node)) return node;

    return RefillFreeListAndAllocateNode(owner, trace);
  }

  V8_INLINE void FreeNode(PersistentNode* node) {
    PersistentRegionLock::AssertLocked();
    PersistentRegionBase::FreeNode(node);
  }

  void Iterate(RootVisitor&);

  size_t NodesInUse() const;

  void ClearAllUsedNodes();
};

}  // namespace internal

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_INTERNAL_PERSISTENT_NODE_H_
