// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_ALLOCATION_H_
#define INCLUDE_CPPGC_ALLOCATION_H_

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <new>
#include <type_traits>
#include <utility>

#include "cppgc/custom-space.h"
#include "cppgc/internal/api-constants.h"
#include "cppgc/internal/gc-info.h"
#include "cppgc/type-traits.h"
#include "v8config.h"  // NOLINT(build/include_directory)

#if defined(__has_attribute)
#if __has_attribute(assume_aligned)
#define CPPGC_DEFAULT_ALIGNED \
  __attribute__((assume_aligned(api_constants::kDefaultAlignment)))
#define CPPGC_DOUBLE_WORD_ALIGNED \
  __attribute__((assume_aligned(2 * api_constants::kDefaultAlignment)))
#endif  // __has_attribute(assume_aligned)
#endif  // defined(__has_attribute)

#if !defined(CPPGC_DEFAULT_ALIGNED)
#define CPPGC_DEFAULT_ALIGNED
#endif

#if !defined(CPPGC_DOUBLE_WORD_ALIGNED)
#define CPPGC_DOUBLE_WORD_ALIGNED
#endif

namespace cppgc {

/**
 * AllocationHandle is used to allocate garbage-collected objects.
 */
class AllocationHandle;

namespace internal {

// Similar to C++17 std::align_val_t;
enum class AlignVal : size_t {};

class V8_EXPORT MakeGarbageCollectedTraitInternal {
 protected:
  static inline void MarkObjectAsFullyConstructed(const void* payload) {
    // See api_constants for an explanation of the constants.
    std::atomic<uint16_t>* atomic_mutable_bitfield =
        reinterpret_cast<std::atomic<uint16_t>*>(
            const_cast<uint16_t*>(reinterpret_cast<const uint16_t*>(
                reinterpret_cast<const uint8_t*>(payload) -
                api_constants::kFullyConstructedBitFieldOffsetFromPayload)));
    // It's safe to split use load+store here (instead of a read-modify-write
    // operation), since it's guaranteed that this 16-bit bitfield is only
    // modified by a single thread. This is cheaper in terms of code bloat (on
    // ARM) and performance.
    uint16_t value = atomic_mutable_bitfield->load(std::memory_order_relaxed);
    value |= api_constants::kFullyConstructedBitMask;
    atomic_mutable_bitfield->store(value, std::memory_order_release);
  }

  // Dispatch based on compile-time information.
  //
  // Default implementation is for a custom space with >`kDefaultAlignment` byte
  // alignment.
  template <typename GCInfoType, typename CustomSpace, size_t alignment>
  struct AllocationDispatcher final {
    static void* Invoke(AllocationHandle& handle, size_t size) {
      static_assert(std::is_base_of<CustomSpaceBase, CustomSpace>::value,
                    "Custom space must inherit from CustomSpaceBase.");
      static_assert(
          !CustomSpace::kSupportsCompaction,
          "Custom spaces that support compaction do not support allocating "
          "objects with non-default (i.e. word-sized) alignment.");
      return MakeGarbageCollectedTraitInternal::Allocate(
          handle, size, static_cast<AlignVal>(alignment),
          internal::GCInfoTrait<GCInfoType>::Index(), CustomSpace::kSpaceIndex);
    }
  };

  // Fast path for regular allocations for the default space with
  // `kDefaultAlignment` byte alignment.
  template <typename GCInfoType>
  struct AllocationDispatcher<GCInfoType, void,
                              api_constants::kDefaultAlignment>
      final {
    static void* Invoke(AllocationHandle& handle, size_t size) {
      return MakeGarbageCollectedTraitInternal::Allocate(
          handle, size, internal::GCInfoTrait<GCInfoType>::Index());
    }
  };

  // Default space with >`kDefaultAlignment` byte alignment.
  template <typename GCInfoType, size_t alignment>
  struct AllocationDispatcher<GCInfoType, void, alignment> final {
    static void* Invoke(AllocationHandle& handle, size_t size) {
      return MakeGarbageCollectedTraitInternal::Allocate(
          handle, size, static_cast<AlignVal>(alignment),
          internal::GCInfoTrait<GCInfoType>::Index());
    }
  };

  // Custom space with `kDefaultAlignment` byte alignment.
  template <typename GCInfoType, typename CustomSpace>
  struct AllocationDispatcher<GCInfoType, CustomSpace,
                              api_constants::kDefaultAlignment>
      final {
    static void* Invoke(AllocationHandle& handle, size_t size) {
      static_assert(std::is_base_of<CustomSpaceBase, CustomSpace>::value,
                    "Custom space must inherit from CustomSpaceBase.");
      return MakeGarbageCollectedTraitInternal::Allocate(
          handle, size, internal::GCInfoTrait<GCInfoType>::Index(),
          CustomSpace::kSpaceIndex);
    }
  };

 private:
  static void* CPPGC_DEFAULT_ALIGNED Allocate(cppgc::AllocationHandle&, size_t,
                                              GCInfoIndex);
  static void* CPPGC_DOUBLE_WORD_ALIGNED Allocate(cppgc::AllocationHandle&,
                                                  size_t, AlignVal,
                                                  GCInfoIndex);
  static void* CPPGC_DEFAULT_ALIGNED Allocate(cppgc::AllocationHandle&, size_t,
                                              GCInfoIndex, CustomSpaceIndex);
  static void* CPPGC_DOUBLE_WORD_ALIGNED Allocate(cppgc::AllocationHandle&,
                                                  size_t, AlignVal, GCInfoIndex,
                                                  CustomSpaceIndex);

  friend class HeapObjectHeader;
};

}  // namespace internal

/**
 * Base trait that provides utilities for advancers users that have custom
 * allocation needs (e.g., overriding size). It's expected that users override
 * MakeGarbageCollectedTrait (see below) and inherit from
 * MakeGarbageCollectedTraitBase and make use of the low-level primitives
 * offered to allocate and construct an object.
 */
template <typename T>
class MakeGarbageCollectedTraitBase
    : private internal::MakeGarbageCollectedTraitInternal {
 private:
  static_assert(internal::IsGarbageCollectedType<T>::value,
                "T needs to be a garbage collected object");
  static_assert(!IsGarbageCollectedWithMixinTypeV<T> ||
                    sizeof(T) <=
                        internal::api_constants::kLargeObjectSizeThreshold,
                "GarbageCollectedMixin may not be a large object");

 protected:
  /**
   * Allocates memory for an object of type T.
   *
   * \param handle AllocationHandle identifying the heap to allocate the object
   *   on.
   * \param size The size that should be reserved for the object.
   * \returns the memory to construct an object of type T on.
   */
  V8_INLINE static void* Allocate(AllocationHandle& handle, size_t size) {
    static_assert(
        std::is_base_of<typename T::ParentMostGarbageCollectedType, T>::value,
        "U of GarbageCollected<U> must be a base of T. Check "
        "GarbageCollected<T> base class inheritance.");
    static constexpr size_t kWantedAlignment =
        alignof(T) < internal::api_constants::kDefaultAlignment
            ? internal::api_constants::kDefaultAlignment
            : alignof(T);
    static_assert(
        kWantedAlignment <= internal::api_constants::kMaxSupportedAlignment,
        "Requested alignment larger than alignof(std::max_align_t) bytes. "
        "Please file a bug to possibly get this restriction lifted.");
    return AllocationDispatcher<
        typename internal::GCInfoFolding<
            T, typename T::ParentMostGarbageCollectedType>::ResultType,
        typename SpaceTrait<T>::Space, kWantedAlignment>::Invoke(handle, size);
  }

  /**
   * Marks an object as fully constructed, resulting in precise handling by the
   * garbage collector.
   *
   * \param payload The base pointer the object is allocated at.
   */
  V8_INLINE static void MarkObjectAsFullyConstructed(const void* payload) {
    internal::MakeGarbageCollectedTraitInternal::MarkObjectAsFullyConstructed(
        payload);
  }
};

/**
 * Passed to MakeGarbageCollected to specify how many bytes should be appended
 * to the allocated object.
 *
 * Example:
 * \code
 * class InlinedArray final : public GarbageCollected<InlinedArray> {
 *  public:
 *   explicit InlinedArray(size_t bytes) : size(bytes), byte_array(this + 1) {}
 *   void Trace(Visitor*) const {}

 *   size_t size;
 *   char* byte_array;
 * };
 *
 * auto* inlined_array = MakeGarbageCollected<InlinedArray(
 *    GetAllocationHandle(), AdditionalBytes(4), 4);
 * for (size_t i = 0; i < 4; i++) {
 *   Process(inlined_array->byte_array[i]);
 * }
 * \endcode
 */
struct AdditionalBytes {
  constexpr explicit AdditionalBytes(size_t bytes) : value(bytes) {}
  const size_t value;
};

/**
 * Default trait class that specifies how to construct an object of type T.
 * Advanced users may override how an object is constructed using the utilities
 * that are provided through MakeGarbageCollectedTraitBase.
 *
 * Any trait overriding construction must
 * - allocate through `MakeGarbageCollectedTraitBase<T>::Allocate`;
 * - mark the object as fully constructed using
 *   `MakeGarbageCollectedTraitBase<T>::MarkObjectAsFullyConstructed`;
 */
template <typename T>
class MakeGarbageCollectedTrait : public MakeGarbageCollectedTraitBase<T> {
 public:
  template <typename... Args>
  static T* Call(AllocationHandle& handle, Args&&... args) {
    void* memory =
        MakeGarbageCollectedTraitBase<T>::Allocate(handle, sizeof(T));
    T* object = ::new (memory) T(std::forward<Args>(args)...);
    MakeGarbageCollectedTraitBase<T>::MarkObjectAsFullyConstructed(object);
    return object;
  }

  template <typename... Args>
  static T* Call(AllocationHandle& handle, AdditionalBytes additional_bytes,
                 Args&&... args) {
    void* memory = MakeGarbageCollectedTraitBase<T>::Allocate(
        handle, sizeof(T) + additional_bytes.value);
    T* object = ::new (memory) T(std::forward<Args>(args)...);
    MakeGarbageCollectedTraitBase<T>::MarkObjectAsFullyConstructed(object);
    return object;
  }
};

/**
 * Allows users to specify a post-construction callback for specific types. The
 * callback is invoked on the instance of type T right after it has been
 * constructed. This can be useful when the callback requires a
 * fully-constructed object to be able to dispatch to virtual methods.
 */
template <typename T, typename = void>
struct PostConstructionCallbackTrait {
  static void Call(T*) {}
};

/**
 * Constructs a managed object of type T where T transitively inherits from
 * GarbageCollected.
 *
 * \param args List of arguments with which an instance of T will be
 *   constructed.
 * \returns an instance of type T.
 */
template <typename T, typename... Args>
V8_INLINE T* MakeGarbageCollected(AllocationHandle& handle, Args&&... args) {
  T* object =
      MakeGarbageCollectedTrait<T>::Call(handle, std::forward<Args>(args)...);
  PostConstructionCallbackTrait<T>::Call(object);
  return object;
}

/**
 * Constructs a managed object of type T where T transitively inherits from
 * GarbageCollected. Created objects will have additional bytes appended to
 * it. Allocated memory would suffice for `sizeof(T) + additional_bytes`.
 *
 * \param additional_bytes Denotes how many bytes to append to T.
 * \param args List of arguments with which an instance of T will be
 *   constructed.
 * \returns an instance of type T.
 */
template <typename T, typename... Args>
V8_INLINE T* MakeGarbageCollected(AllocationHandle& handle,
                                  AdditionalBytes additional_bytes,
                                  Args&&... args) {
  T* object = MakeGarbageCollectedTrait<T>::Call(handle, additional_bytes,
                                                 std::forward<Args>(args)...);
  PostConstructionCallbackTrait<T>::Call(object);
  return object;
}

}  // namespace cppgc

#undef CPPGC_DEFAULT_ALIGNED
#undef CPPGC_DOUBLE_WORD_ALIGNED

#endif  // INCLUDE_CPPGC_ALLOCATION_H_
