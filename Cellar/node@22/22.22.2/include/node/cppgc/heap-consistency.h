// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_HEAP_CONSISTENCY_H_
#define INCLUDE_CPPGC_HEAP_CONSISTENCY_H_

#include <cstddef>

#include "cppgc/internal/write-barrier.h"
#include "cppgc/macros.h"
#include "cppgc/member.h"
#include "cppgc/trace-trait.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

class HeapHandle;

namespace subtle {

/**
 * **DO NOT USE: Use the appropriate managed types.**
 *
 * Consistency helpers that aid in maintaining a consistent internal state of
 * the garbage collector.
 */
class HeapConsistency final {
 public:
  using WriteBarrierParams = internal::WriteBarrier::Params;
  using WriteBarrierType = internal::WriteBarrier::Type;

  /**
   * Gets the required write barrier type for a specific write.
   *
   * \param slot Slot containing the pointer to the object. The slot itself
   *   must reside in an object that has been allocated using
   *   `MakeGarbageCollected()`.
   * \param value The pointer to the object. May be an interior pointer to an
   *   interface of the actual object.
   * \param params Parameters that may be used for actual write barrier calls.
   *   Only filled if return value indicates that a write barrier is needed. The
   *   contents of the `params` are an implementation detail.
   * \returns whether a write barrier is needed and which barrier to invoke.
   */
  static V8_INLINE WriteBarrierType GetWriteBarrierType(
      const void* slot, const void* value, WriteBarrierParams& params) {
    return internal::WriteBarrier::GetWriteBarrierType(slot, value, params);
  }

  /**
   * Gets the required write barrier type for a specific write. This override is
   * only used for all the BasicMember types.
   *
   * \param slot Slot containing the pointer to the object. The slot itself
   *   must reside in an object that has been allocated using
   *   `MakeGarbageCollected()`.
   * \param value The pointer to the object held via `BasicMember`.
   * \param params Parameters that may be used for actual write barrier calls.
   *   Only filled if return value indicates that a write barrier is needed. The
   *   contents of the `params` are an implementation detail.
   * \returns whether a write barrier is needed and which barrier to invoke.
   */
  template <typename T, typename WeaknessTag, typename WriteBarrierPolicy,
            typename CheckingPolicy, typename StorageType>
  static V8_INLINE WriteBarrierType GetWriteBarrierType(
      const internal::BasicMember<T, WeaknessTag, WriteBarrierPolicy,
                                  CheckingPolicy, StorageType>& value,
      WriteBarrierParams& params) {
    return internal::WriteBarrier::GetWriteBarrierType(
        value.GetRawSlot(), value.GetRawStorage(), params);
  }

  /**
   * Gets the required write barrier type for a specific write.
   *
   * \param slot Slot to some part of an object. The object must not necessarily
       have been allocated using `MakeGarbageCollected()` but can also live
       off-heap or on stack.
   * \param params Parameters that may be used for actual write barrier calls.
   *   Only filled if return value indicates that a write barrier is needed. The
   *   contents of the `params` are an implementation detail.
   * \param callback Callback returning the corresponding heap handle. The
   *   callback is only invoked if the heap cannot otherwise be figured out. The
   *   callback must not allocate.
   * \returns whether a write barrier is needed and which barrier to invoke.
   */
  template <typename HeapHandleCallback>
  static V8_INLINE WriteBarrierType
  GetWriteBarrierType(const void* slot, WriteBarrierParams& params,
                      HeapHandleCallback callback) {
    return internal::WriteBarrier::GetWriteBarrierType(slot, params, callback);
  }

  /**
   * Gets the required write barrier type for a specific write.
   * This version is meant to be used in conjunction with with a marking write
   * barrier barrier which doesn't consider the slot.
   *
   * \param value The pointer to the object. May be an interior pointer to an
   *   interface of the actual object.
   * \param params Parameters that may be used for actual write barrier calls.
   *   Only filled if return value indicates that a write barrier is needed. The
   *   contents of the `params` are an implementation detail.
   * \returns whether a write barrier is needed and which barrier to invoke.
   */
  static V8_INLINE WriteBarrierType
  GetWriteBarrierType(const void* value, WriteBarrierParams& params) {
    return internal::WriteBarrier::GetWriteBarrierType(value, params);
  }

  /**
   * Conservative Dijkstra-style write barrier that processes an object if it
   * has not yet been processed.
   *
   * \param params The parameters retrieved from `GetWriteBarrierType()`.
   * \param object The pointer to the object. May be an interior pointer to a
   *   an interface of the actual object.
   */
  static V8_INLINE void DijkstraWriteBarrier(const WriteBarrierParams& params,
                                             const void* object) {
    internal::WriteBarrier::DijkstraMarkingBarrier(params, object);
  }

  /**
   * Conservative Dijkstra-style write barrier that processes a range of
   * elements if they have not yet been processed.
   *
   * \param params The parameters retrieved from `GetWriteBarrierType()`.
   * \param first_element Pointer to the first element that should be processed.
   *   The slot itself must reside in an object that has been allocated using
   *   `MakeGarbageCollected()`.
   * \param element_size Size of the element in bytes.
   * \param number_of_elements Number of elements that should be processed,
   *   starting with `first_element`.
   * \param trace_callback The trace callback that should be invoked for each
   *   element if necessary.
   */
  static V8_INLINE void DijkstraWriteBarrierRange(
      const WriteBarrierParams& params, const void* first_element,
      size_t element_size, size_t number_of_elements,
      TraceCallback trace_callback) {
    internal::WriteBarrier::DijkstraMarkingBarrierRange(
        params, first_element, element_size, number_of_elements,
        trace_callback);
  }

  /**
   * Steele-style write barrier that re-processes an object if it has already
   * been processed.
   *
   * \param params The parameters retrieved from `GetWriteBarrierType()`.
   * \param object The pointer to the object which must point to an object that
   *   has been allocated using `MakeGarbageCollected()`. Interior pointers are
   *   not supported.
   */
  static V8_INLINE void SteeleWriteBarrier(const WriteBarrierParams& params,
                                           const void* object) {
    internal::WriteBarrier::SteeleMarkingBarrier(params, object);
  }

  /**
   * Generational barrier for maintaining consistency when running with multiple
   * generations.
   *
   * \param params The parameters retrieved from `GetWriteBarrierType()`.
   * \param slot Slot containing the pointer to the object. The slot itself
   *   must reside in an object that has been allocated using
   *   `MakeGarbageCollected()`.
   */
  static V8_INLINE void GenerationalBarrier(const WriteBarrierParams& params,
                                            const void* slot) {
    internal::WriteBarrier::GenerationalBarrier<
        internal::WriteBarrier::GenerationalBarrierType::kPreciseSlot>(params,
                                                                       slot);
  }

  /**
   * Generational barrier for maintaining consistency when running with multiple
   * generations. This version is used when slot contains uncompressed pointer.
   *
   * \param params The parameters retrieved from `GetWriteBarrierType()`.
   * \param slot Uncompressed slot containing the direct pointer to the object.
   * The slot itself must reside in an object that has been allocated using
   *   `MakeGarbageCollected()`.
   */
  static V8_INLINE void GenerationalBarrierForUncompressedSlot(
      const WriteBarrierParams& params, const void* uncompressed_slot) {
    internal::WriteBarrier::GenerationalBarrier<
        internal::WriteBarrier::GenerationalBarrierType::
            kPreciseUncompressedSlot>(params, uncompressed_slot);
  }

  /**
   * Generational barrier for source object that may contain outgoing pointers
   * to objects in young generation.
   *
   * \param params The parameters retrieved from `GetWriteBarrierType()`.
   * \param inner_pointer Pointer to the source object.
   */
  static V8_INLINE void GenerationalBarrierForSourceObject(
      const WriteBarrierParams& params, const void* inner_pointer) {
    internal::WriteBarrier::GenerationalBarrier<
        internal::WriteBarrier::GenerationalBarrierType::kImpreciseSlot>(
        params, inner_pointer);
  }

 private:
  HeapConsistency() = delete;
};

/**
 * Disallows garbage collection finalizations. Any garbage collection triggers
 * result in a crash when in this scope.
 *
 * Note that the garbage collector already covers paths that can lead to garbage
 * collections, so user code does not require checking
 * `IsGarbageCollectionAllowed()` before allocations.
 */
class V8_EXPORT V8_NODISCARD DisallowGarbageCollectionScope final {
  CPPGC_STACK_ALLOCATED();

 public:
  /**
   * \returns whether garbage collections are currently allowed.
   */
  static bool IsGarbageCollectionAllowed(HeapHandle& heap_handle);

  /**
   * Enters a disallow garbage collection scope. Must be paired with `Leave()`.
   * Prefer a scope instance of `DisallowGarbageCollectionScope`.
   *
   * \param heap_handle The corresponding heap.
   */
  static void Enter(HeapHandle& heap_handle);

  /**
   * Leaves a disallow garbage collection scope. Must be paired with `Enter()`.
   * Prefer a scope instance of `DisallowGarbageCollectionScope`.
   *
   * \param heap_handle The corresponding heap.
   */
  static void Leave(HeapHandle& heap_handle);

  /**
   * Constructs a scoped object that automatically enters and leaves a disallow
   * garbage collection scope based on its lifetime.
   *
   * \param heap_handle The corresponding heap.
   */
  explicit DisallowGarbageCollectionScope(HeapHandle& heap_handle);
  ~DisallowGarbageCollectionScope();

  DisallowGarbageCollectionScope(const DisallowGarbageCollectionScope&) =
      delete;
  DisallowGarbageCollectionScope& operator=(
      const DisallowGarbageCollectionScope&) = delete;

 private:
  HeapHandle& heap_handle_;
};

/**
 * Avoids invoking garbage collection finalizations. Already running garbage
 * collection phase are unaffected by this scope.
 *
 * Should only be used temporarily as the scope has an impact on memory usage
 * and follow up garbage collections.
 */
class V8_EXPORT V8_NODISCARD NoGarbageCollectionScope final {
  CPPGC_STACK_ALLOCATED();

 public:
  /**
   * Enters a no garbage collection scope. Must be paired with `Leave()`. Prefer
   * a scope instance of `NoGarbageCollectionScope`.
   *
   * \param heap_handle The corresponding heap.
   */
  static void Enter(HeapHandle& heap_handle);

  /**
   * Leaves a no garbage collection scope. Must be paired with `Enter()`. Prefer
   * a scope instance of `NoGarbageCollectionScope`.
   *
   * \param heap_handle The corresponding heap.
   */
  static void Leave(HeapHandle& heap_handle);

  /**
   * Constructs a scoped object that automatically enters and leaves a no
   * garbage collection scope based on its lifetime.
   *
   * \param heap_handle The corresponding heap.
   */
  explicit NoGarbageCollectionScope(HeapHandle& heap_handle);
  ~NoGarbageCollectionScope();

  NoGarbageCollectionScope(const NoGarbageCollectionScope&) = delete;
  NoGarbageCollectionScope& operator=(const NoGarbageCollectionScope&) = delete;

 private:
  HeapHandle& heap_handle_;
};

}  // namespace subtle
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_HEAP_CONSISTENCY_H_
