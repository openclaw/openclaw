// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_TRACED_HANDLE_H_
#define INCLUDE_V8_TRACED_HANDLE_H_

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include <atomic>
#include <memory>
#include <type_traits>
#include <utility>

#include "v8-internal.h"            // NOLINT(build/include_directory)
#include "v8-local-handle.h"        // NOLINT(build/include_directory)
#include "v8-weak-callback-info.h"  // NOLINT(build/include_directory)
#include "v8config.h"               // NOLINT(build/include_directory)

namespace v8 {

class Value;

namespace internal {

class BasicTracedReferenceExtractor;

enum class TracedReferenceStoreMode {
  kInitializingStore,
  kAssigningStore,
};

enum class TracedReferenceHandling {
  kDefault,  // See EmbedderRootsHandler::IsRoot().
  kDroppable
};

V8_EXPORT internal::Address* GlobalizeTracedReference(
    internal::Isolate* isolate, internal::Address value,
    internal::Address* slot, TracedReferenceStoreMode store_mode,
    internal::TracedReferenceHandling reference_handling);
V8_EXPORT void MoveTracedReference(internal::Address** from,
                                   internal::Address** to);
V8_EXPORT void CopyTracedReference(const internal::Address* const* from,
                                   internal::Address** to);
V8_EXPORT void DisposeTracedReference(internal::Address* global_handle);

}  // namespace internal

/**
 * An indirect handle, where the indirect pointer points to a GlobalHandles
 * node.
 */
class TracedReferenceBase : public api_internal::IndirectHandleBase {
 public:
  /**
   * If non-empty, destroy the underlying storage cell. |IsEmpty| will return
   * true after this call.
   */
  V8_INLINE void Reset();

  /**
   * Construct a Local<Value> from this handle.
   */
  V8_INLINE Local<Value> Get(Isolate* isolate) const {
    if (IsEmpty()) return Local<Value>();
    return Local<Value>::New(isolate, this->value<Value>());
  }

  /**
   * Returns true if this TracedReference is empty, i.e., has not been
   * assigned an object. This version of IsEmpty is thread-safe.
   */
  bool IsEmptyThreadSafe() const {
    return this->GetSlotThreadSafe() == nullptr;
  }

 protected:
  V8_INLINE TracedReferenceBase() = default;

  /**
   * Update this reference in a thread-safe way.
   */
  void SetSlotThreadSafe(void* new_val) {
    reinterpret_cast<std::atomic<void*>*>(&slot())->store(
        new_val, std::memory_order_relaxed);
  }

  /**
   * Get this reference in a thread-safe way
   */
  const void* GetSlotThreadSafe() const {
    return reinterpret_cast<std::atomic<const void*> const*>(&slot())->load(
        std::memory_order_relaxed);
  }

  V8_EXPORT void CheckValue() const;

  friend class internal::BasicTracedReferenceExtractor;
  template <typename F>
  friend class Local;
  template <typename U>
  friend bool operator==(const TracedReferenceBase&, const Local<U>&);
  friend bool operator==(const TracedReferenceBase&,
                         const TracedReferenceBase&);
};

/**
 * A traced handle with copy and move semantics. The handle is to be used
 * together as part of GarbageCollected objects (see v8-cppgc.h) or from stack
 * and specifies edges from C++ objects to JavaScript.
 *
 * The exact semantics are:
 * - Tracing garbage collections using CppHeap.
 * - Non-tracing garbage collections refer to
 *   |v8::EmbedderRootsHandler::IsRoot()| whether the handle should
 * be treated as root or not.
 *
 * Note that the base class cannot be instantiated itself, use |TracedReference|
 * instead.
 */
template <typename T>
class BasicTracedReference : public TracedReferenceBase {
 public:
  /**
   * Construct a Local<T> from this handle.
   */
  Local<T> Get(Isolate* isolate) const { return Local<T>::New(isolate, *this); }

  template <class S>
  V8_INLINE BasicTracedReference<S>& As() const {
    return reinterpret_cast<BasicTracedReference<S>&>(
        const_cast<BasicTracedReference<T>&>(*this));
  }

  V8_DEPRECATE_SOON("Use Get to convert to Local instead")
  V8_INLINE T* operator->() const {
#ifdef V8_ENABLE_CHECKS
    CheckValue();
#endif  // V8_ENABLE_CHECKS
    return this->template value<T>();
  }

  V8_DEPRECATE_SOON("Use Get to convert to Local instead")
  V8_INLINE T* operator*() const { return this->operator->(); }

 private:
  /**
   * An empty BasicTracedReference without storage cell.
   */
  BasicTracedReference() = default;

  V8_INLINE static internal::Address* NewFromNonEmptyValue(
      Isolate* isolate, T* that, internal::Address** slot,
      internal::TracedReferenceStoreMode store_mode,
      internal::TracedReferenceHandling reference_handling);

  template <typename F>
  friend class Local;
  friend class Object;
  template <typename F>
  friend class TracedReference;
  template <typename F>
  friend class BasicTracedReference;
  template <typename F>
  friend class ReturnValue;
};

/**
 * A traced handle without destructor that clears the handle. The embedder needs
 * to ensure that the handle is not accessed once the V8 object has been
 * reclaimed. For more details see BasicTracedReference.
 */
template <typename T>
class TracedReference : public BasicTracedReference<T> {
 public:
  struct IsDroppable {};

  using BasicTracedReference<T>::Reset;

  /**
   * An empty TracedReference without storage cell.
   */
  V8_INLINE TracedReference() = default;

  /**
   * Construct a TracedReference from a Local.
   *
   * When the Local is non-empty, a new storage cell is created
   * pointing to the same object.
   */
  template <class S>
  TracedReference(Isolate* isolate, Local<S> that) : BasicTracedReference<T>() {
    static_assert(std::is_base_of<T, S>::value, "type check");
    if (V8_UNLIKELY(that.IsEmpty())) {
      return;
    }
    this->slot() = this->NewFromNonEmptyValue(
        isolate, *that, &this->slot(),
        internal::TracedReferenceStoreMode::kInitializingStore,
        internal::TracedReferenceHandling::kDefault);
  }

  /**
   * Construct a droppable TracedReference from a Local. Droppable means that V8
   * is free to reclaim the pointee if it is unmodified and otherwise
   * unreachable
   *
   * When the Local is non-empty, a new storage cell is created
   * pointing to the same object.
   */
  template <class S>
  TracedReference(Isolate* isolate, Local<S> that, IsDroppable)
      : BasicTracedReference<T>() {
    static_assert(std::is_base_of<T, S>::value, "type check");
    if (V8_UNLIKELY(that.IsEmpty())) {
      return;
    }
    this->slot() = this->NewFromNonEmptyValue(
        isolate, *that, &this->slot(),
        internal::TracedReferenceStoreMode::kInitializingStore,
        internal::TracedReferenceHandling::kDroppable);
  }

  /**
   * Move constructor initializing TracedReference from an
   * existing one.
   */
  V8_INLINE TracedReference(TracedReference&& other) noexcept {
    // Forward to operator=.
    *this = std::move(other);
  }

  /**
   * Move constructor initializing TracedReference from an
   * existing one.
   */
  template <typename S>
  V8_INLINE TracedReference(TracedReference<S>&& other) noexcept {
    // Forward to operator=.
    *this = std::move(other);
  }

  /**
   * Copy constructor initializing TracedReference from an
   * existing one.
   */
  V8_INLINE TracedReference(const TracedReference& other) {
    // Forward to operator=;
    *this = other;
  }

  /**
   * Copy constructor initializing TracedReference from an
   * existing one.
   */
  template <typename S>
  V8_INLINE TracedReference(const TracedReference<S>& other) {
    // Forward to operator=;
    *this = other;
  }

  /**
   * Move assignment operator initializing TracedReference from an existing one.
   */
  V8_INLINE TracedReference& operator=(TracedReference&& rhs) noexcept;

  /**
   * Move assignment operator initializing TracedReference from an existing one.
   */
  template <class S>
  V8_INLINE TracedReference& operator=(TracedReference<S>&& rhs) noexcept;

  /**
   * Copy assignment operator initializing TracedReference from an existing one.
   */
  V8_INLINE TracedReference& operator=(const TracedReference& rhs);

  /**
   * Copy assignment operator initializing TracedReference from an existing one.
   */
  template <class S>
  V8_INLINE TracedReference& operator=(const TracedReference<S>& rhs);

  /**
   * Always resets the reference. Creates a new reference from `other` if it is
   * non-empty.
   */
  template <class S>
  V8_INLINE void Reset(Isolate* isolate, const Local<S>& other);

  /**
   * Always resets the reference. Creates a new reference from `other` if it is
   * non-empty. The new reference is droppable, see constructor.
   */
  template <class S>
  V8_INLINE void Reset(Isolate* isolate, const Local<S>& other, IsDroppable);

  template <class S>
  V8_INLINE TracedReference<S>& As() const {
    return reinterpret_cast<TracedReference<S>&>(
        const_cast<TracedReference<T>&>(*this));
  }
};

// --- Implementation ---
template <class T>
internal::Address* BasicTracedReference<T>::NewFromNonEmptyValue(
    Isolate* isolate, T* that, internal::Address** slot,
    internal::TracedReferenceStoreMode store_mode,
    internal::TracedReferenceHandling reference_handling) {
  return internal::GlobalizeTracedReference(
      reinterpret_cast<internal::Isolate*>(isolate),
      internal::ValueHelper::ValueAsAddress(that),
      reinterpret_cast<internal::Address*>(slot), store_mode,
      reference_handling);
}

void TracedReferenceBase::Reset() {
  if (V8_UNLIKELY(IsEmpty())) {
    return;
  }
  internal::DisposeTracedReference(slot());
  SetSlotThreadSafe(nullptr);
}

V8_INLINE bool operator==(const TracedReferenceBase& lhs,
                          const TracedReferenceBase& rhs) {
  return internal::HandleHelper::EqualHandles(lhs, rhs);
}

template <typename U>
V8_INLINE bool operator==(const TracedReferenceBase& lhs,
                          const v8::Local<U>& rhs) {
  return internal::HandleHelper::EqualHandles(lhs, rhs);
}

template <typename U>
V8_INLINE bool operator==(const v8::Local<U>& lhs,
                          const TracedReferenceBase& rhs) {
  return rhs == lhs;
}

V8_INLINE bool operator!=(const TracedReferenceBase& lhs,
                          const TracedReferenceBase& rhs) {
  return !(lhs == rhs);
}

template <typename U>
V8_INLINE bool operator!=(const TracedReferenceBase& lhs,
                          const v8::Local<U>& rhs) {
  return !(lhs == rhs);
}

template <typename U>
V8_INLINE bool operator!=(const v8::Local<U>& lhs,
                          const TracedReferenceBase& rhs) {
  return !(rhs == lhs);
}

template <class T>
template <class S>
void TracedReference<T>::Reset(Isolate* isolate, const Local<S>& other) {
  static_assert(std::is_base_of<T, S>::value, "type check");
  this->Reset();
  if (V8_UNLIKELY(other.IsEmpty())) {
    return;
  }
  this->SetSlotThreadSafe(this->NewFromNonEmptyValue(
      isolate, *other, &this->slot(),
      internal::TracedReferenceStoreMode::kAssigningStore,
      internal::TracedReferenceHandling::kDefault));
}

template <class T>
template <class S>
void TracedReference<T>::Reset(Isolate* isolate, const Local<S>& other,
                               IsDroppable) {
  static_assert(std::is_base_of<T, S>::value, "type check");
  this->Reset();
  if (V8_UNLIKELY(other.IsEmpty())) {
    return;
  }
  this->SetSlotThreadSafe(this->NewFromNonEmptyValue(
      isolate, *other, &this->slot(),
      internal::TracedReferenceStoreMode::kAssigningStore,
      internal::TracedReferenceHandling::kDroppable));
}

template <class T>
template <class S>
TracedReference<T>& TracedReference<T>::operator=(
    TracedReference<S>&& rhs) noexcept {
  static_assert(std::is_base_of<T, S>::value, "type check");
  *this = std::move(rhs.template As<T>());
  return *this;
}

template <class T>
template <class S>
TracedReference<T>& TracedReference<T>::operator=(
    const TracedReference<S>& rhs) {
  static_assert(std::is_base_of<T, S>::value, "type check");
  *this = rhs.template As<T>();
  return *this;
}

template <class T>
TracedReference<T>& TracedReference<T>::operator=(
    TracedReference&& rhs) noexcept {
  if (this != &rhs) {
    internal::MoveTracedReference(&rhs.slot(), &this->slot());
  }
  return *this;
}

template <class T>
TracedReference<T>& TracedReference<T>::operator=(const TracedReference& rhs) {
  if (this != &rhs) {
    this->Reset();
    if (!rhs.IsEmpty()) {
      internal::CopyTracedReference(&rhs.slot(), &this->slot());
    }
  }
  return *this;
}

}  // namespace v8

#endif  // INCLUDE_V8_TRACED_HANDLE_H_
