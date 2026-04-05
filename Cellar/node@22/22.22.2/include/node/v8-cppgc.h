// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_CPPGC_H_
#define INCLUDE_V8_CPPGC_H_

#include <cstdint>
#include <memory>
#include <vector>

#include "cppgc/common.h"
#include "cppgc/custom-space.h"
#include "cppgc/heap-statistics.h"
#include "cppgc/visitor.h"
#include "v8-internal.h"       // NOLINT(build/include_directory)
#include "v8-platform.h"       // NOLINT(build/include_directory)
#include "v8-traced-handle.h"  // NOLINT(build/include_directory)

namespace cppgc {
class AllocationHandle;
class HeapHandle;
}  // namespace cppgc

namespace v8 {

class Object;

namespace internal {
class CppHeap;
}  // namespace internal

class CustomSpaceStatisticsReceiver;

/**
 * Describes how V8 wrapper objects maintain references to garbage-collected C++
 * objects.
 */
struct WrapperDescriptor final {
  /**
   * The index used on `v8::Ojbect::SetAlignedPointerFromInternalField()` and
   * related APIs to add additional data to an object which is used to identify
   * JS->C++ references.
   */
  using InternalFieldIndex = int;

  /**
   * Unknown embedder id. The value is reserved for internal usages and must not
   * be used with `CppHeap`.
   */
  static constexpr uint16_t kUnknownEmbedderId = UINT16_MAX;

  constexpr WrapperDescriptor(InternalFieldIndex wrappable_type_index,
                              InternalFieldIndex wrappable_instance_index,
                              uint16_t embedder_id_for_garbage_collected)
      : wrappable_type_index(wrappable_type_index),
        wrappable_instance_index(wrappable_instance_index),
        embedder_id_for_garbage_collected(embedder_id_for_garbage_collected) {}

  /**
   * Index of the wrappable type.
   */
  InternalFieldIndex wrappable_type_index;

  /**
   * Index of the wrappable instance.
   */
  InternalFieldIndex wrappable_instance_index;

  /**
   * Embedder id identifying instances of garbage-collected objects. It is
   * expected that the first field of the wrappable type is a uint16_t holding
   * the id. Only references to instances of wrappables types with an id of
   * `embedder_id_for_garbage_collected` will be considered by CppHeap.
   */
  uint16_t embedder_id_for_garbage_collected;
};

struct V8_EXPORT CppHeapCreateParams {
  CppHeapCreateParams(
      std::vector<std::unique_ptr<cppgc::CustomSpaceBase>> custom_spaces,
      WrapperDescriptor wrapper_descriptor)
      : custom_spaces(std::move(custom_spaces)),
        wrapper_descriptor(wrapper_descriptor) {}

  CppHeapCreateParams(const CppHeapCreateParams&) = delete;
  CppHeapCreateParams& operator=(const CppHeapCreateParams&) = delete;

  std::vector<std::unique_ptr<cppgc::CustomSpaceBase>> custom_spaces;
  WrapperDescriptor wrapper_descriptor;
  /**
   * Specifies which kind of marking are supported by the heap. The type may be
   * further reduced via runtime flags when attaching the heap to an Isolate.
   */
  cppgc::Heap::MarkingType marking_support =
      cppgc::Heap::MarkingType::kIncrementalAndConcurrent;
  /**
   * Specifies which kind of sweeping is supported by the heap. The type may be
   * further reduced via runtime flags when attaching the heap to an Isolate.
   */
  cppgc::Heap::SweepingType sweeping_support =
      cppgc::Heap::SweepingType::kIncrementalAndConcurrent;
};

/**
 * A heap for allocating managed C++ objects.
 *
 * Similar to v8::Isolate, the heap may only be accessed from one thread at a
 * time. The heap may be used from different threads using the
 * v8::Locker/v8::Unlocker APIs which is different from generic Oilpan.
 */
class V8_EXPORT CppHeap {
 public:
  static std::unique_ptr<CppHeap> Create(v8::Platform* platform,
                                         const CppHeapCreateParams& params);

  virtual ~CppHeap() = default;

  /**
   * \returns the opaque handle for allocating objects using
   * `MakeGarbageCollected()`.
   */
  cppgc::AllocationHandle& GetAllocationHandle();

  /**
   * \returns the opaque heap handle which may be used to refer to this heap in
   *   other APIs. Valid as long as the underlying `CppHeap` is alive.
   */
  cppgc::HeapHandle& GetHeapHandle();

  /**
   * Terminate clears all roots and performs multiple garbage collections to
   * reclaim potentially newly created objects in destructors.
   *
   * After this call, object allocation is prohibited.
   */
  void Terminate();

  /**
   * \param detail_level specifies whether should return detailed
   *   statistics or only brief summary statistics.
   * \returns current CppHeap statistics regarding memory consumption
   *   and utilization.
   */
  cppgc::HeapStatistics CollectStatistics(
      cppgc::HeapStatistics::DetailLevel detail_level);

  /**
   * Collects statistics for the given spaces and reports them to the receiver.
   *
   * \param custom_spaces a collection of custom space indicies.
   * \param receiver an object that gets the results.
   */
  void CollectCustomSpaceStatisticsAtLastGC(
      std::vector<cppgc::CustomSpaceIndex> custom_spaces,
      std::unique_ptr<CustomSpaceStatisticsReceiver> receiver);

  /**
   * Enables a detached mode that allows testing garbage collection using
   * `cppgc::testing` APIs. Once used, the heap cannot be attached to an
   * `Isolate` anymore.
   */
  void EnableDetachedGarbageCollectionsForTesting();

  /**
   * Performs a stop-the-world garbage collection for testing purposes.
   *
   * \param stack_state The stack state to assume for the garbage collection.
   */
  void CollectGarbageForTesting(cppgc::EmbedderStackState stack_state);

  /**
   * Performs a stop-the-world minor garbage collection for testing purposes.
   *
   * \param stack_state The stack state to assume for the garbage collection.
   */
  void CollectGarbageInYoungGenerationForTesting(
      cppgc::EmbedderStackState stack_state);

  /**
   * \returns the wrapper descriptor of this CppHeap.
   */
  v8::WrapperDescriptor wrapper_descriptor() const;

 private:
  CppHeap() = default;

  friend class internal::CppHeap;
};

class JSVisitor : public cppgc::Visitor {
 public:
  explicit JSVisitor(cppgc::Visitor::Key key) : cppgc::Visitor(key) {}
  ~JSVisitor() override = default;

  void Trace(const TracedReferenceBase& ref) {
    if (ref.IsEmptyThreadSafe()) return;
    Visit(ref);
  }

 protected:
  using cppgc::Visitor::Visit;

  virtual void Visit(const TracedReferenceBase& ref) {}
};

/**
 * Provided as input to `CppHeap::CollectCustomSpaceStatisticsAtLastGC()`.
 *
 * Its method is invoked with the results of the statistic collection.
 */
class CustomSpaceStatisticsReceiver {
 public:
  virtual ~CustomSpaceStatisticsReceiver() = default;
  /**
   * Reports the size of a space at the last GC. It is called for each space
   * that was requested in `CollectCustomSpaceStatisticsAtLastGC()`.
   *
   * \param space_index The index of the space.
   * \param bytes The total size of live objects in the space at the last GC.
   *    It is zero if there was no GC yet.
   */
  virtual void AllocatedBytes(cppgc::CustomSpaceIndex space_index,
                              size_t bytes) = 0;
};

}  // namespace v8

namespace cppgc {

template <typename T>
struct TraceTrait<v8::TracedReference<T>> {
  static cppgc::TraceDescriptor GetTraceDescriptor(const void* self) {
    return {nullptr, Trace};
  }

  static void Trace(Visitor* visitor, const void* self) {
    static_cast<v8::JSVisitor*>(visitor)->Trace(
        *static_cast<const v8::TracedReference<T>*>(self));
  }
};

}  // namespace cppgc

#endif  // INCLUDE_V8_CPPGC_H_
