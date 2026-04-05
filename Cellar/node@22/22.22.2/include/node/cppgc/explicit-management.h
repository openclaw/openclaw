// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_EXPLICIT_MANAGEMENT_H_
#define INCLUDE_CPPGC_EXPLICIT_MANAGEMENT_H_

#include <cstddef>

#include "cppgc/allocation.h"
#include "cppgc/internal/logging.h"
#include "cppgc/type-traits.h"

namespace cppgc {

class HeapHandle;

namespace subtle {

template <typename T>
void FreeUnreferencedObject(HeapHandle& heap_handle, T& object);
template <typename T>
bool Resize(T& object, AdditionalBytes additional_bytes);

}  // namespace subtle

namespace internal {

class ExplicitManagementImpl final {
 private:
  V8_EXPORT static void FreeUnreferencedObject(HeapHandle&, void*);
  V8_EXPORT static bool Resize(void*, size_t);

  template <typename T>
  friend void subtle::FreeUnreferencedObject(HeapHandle&, T&);
  template <typename T>
  friend bool subtle::Resize(T&, AdditionalBytes);
};
}  // namespace internal

namespace subtle {

/**
 * Informs the garbage collector that `object` can be immediately reclaimed. The
 * destructor may not be invoked immediately but only on next garbage
 * collection.
 *
 * It is up to the embedder to guarantee that no other object holds a reference
 * to `object` after calling `FreeUnreferencedObject()`. In case such a
 * reference exists, it's use results in a use-after-free.
 *
 * To aid in using the API, `FreeUnreferencedObject()` may be called from
 * destructors on objects that would be reclaimed in the same garbage collection
 * cycle.
 *
 * \param heap_handle The corresponding heap.
 * \param object Reference to an object that is of type `GarbageCollected` and
 *   should be immediately reclaimed.
 */
template <typename T>
void FreeUnreferencedObject(HeapHandle& heap_handle, T& object) {
  static_assert(IsGarbageCollectedTypeV<T>,
                "Object must be of type GarbageCollected.");
  internal::ExplicitManagementImpl::FreeUnreferencedObject(heap_handle,
                                                           &object);
}

/**
 * Tries to resize `object` of type `T` with additional bytes on top of
 * sizeof(T). Resizing is only useful with trailing inlined storage, see e.g.
 * `MakeGarbageCollected(AllocationHandle&, AdditionalBytes)`.
 *
 * `Resize()` performs growing or shrinking as needed and may skip the operation
 * for internal reasons, see return value.
 *
 * It is up to the embedder to guarantee that in case of shrinking a larger
 * object down, the reclaimed area is not used anymore. Any subsequent use
 * results in a use-after-free.
 *
 * The `object` must be live when calling `Resize()`.
 *
 * \param object Reference to an object that is of type `GarbageCollected` and
 *   should be resized.
 * \param additional_bytes Bytes in addition to sizeof(T) that the object should
 *   provide.
 * \returns true when the operation was successful and the result can be relied
 *   on, and false otherwise.
 */
template <typename T>
bool Resize(T& object, AdditionalBytes additional_bytes) {
  static_assert(IsGarbageCollectedTypeV<T>,
                "Object must be of type GarbageCollected.");
  return internal::ExplicitManagementImpl::Resize(
      &object, sizeof(T) + additional_bytes.value);
}

}  // namespace subtle
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_EXPLICIT_MANAGEMENT_H_
