// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_GC_INFO_H_
#define INCLUDE_CPPGC_INTERNAL_GC_INFO_H_

#include <atomic>
#include <cstdint>
#include <type_traits>

#include "cppgc/internal/finalizer-trait.h"
#include "cppgc/internal/logging.h"
#include "cppgc/internal/name-trait.h"
#include "cppgc/trace-trait.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {
namespace internal {

using GCInfoIndex = uint16_t;

struct V8_EXPORT EnsureGCInfoIndexTrait final {
  // Acquires a new GC info object and updates `registered_index` with the index
  // that identifies that new info accordingly.
  template <typename T>
  V8_INLINE static GCInfoIndex EnsureIndex(
      std::atomic<GCInfoIndex>& registered_index) {
    return EnsureGCInfoIndexTraitDispatch<T>{}(registered_index);
  }

 private:
  template <typename T, bool = FinalizerTrait<T>::HasFinalizer(),
            bool = NameTrait<T>::HasNonHiddenName()>
  struct EnsureGCInfoIndexTraitDispatch;

  static GCInfoIndex V8_PRESERVE_MOST
  EnsureGCInfoIndex(std::atomic<GCInfoIndex>&, TraceCallback,
                    FinalizationCallback, NameCallback);
  static GCInfoIndex V8_PRESERVE_MOST EnsureGCInfoIndex(
      std::atomic<GCInfoIndex>&, TraceCallback, FinalizationCallback);
  static GCInfoIndex V8_PRESERVE_MOST
  EnsureGCInfoIndex(std::atomic<GCInfoIndex>&, TraceCallback, NameCallback);
  static GCInfoIndex V8_PRESERVE_MOST
  EnsureGCInfoIndex(std::atomic<GCInfoIndex>&, TraceCallback);
};

#define DISPATCH(has_finalizer, has_non_hidden_name, function)   \
  template <typename T>                                          \
  struct EnsureGCInfoIndexTrait::EnsureGCInfoIndexTraitDispatch< \
      T, has_finalizer, has_non_hidden_name> {                   \
    V8_INLINE GCInfoIndex                                        \
    operator()(std::atomic<GCInfoIndex>& registered_index) {     \
      return function;                                           \
    }                                                            \
  };

// ------------------------------------------------------- //
// DISPATCH(has_finalizer, has_non_hidden_name, function)  //
// ------------------------------------------------------- //
DISPATCH(true, true,                                       //
         EnsureGCInfoIndex(registered_index,               //
                           TraceTrait<T>::Trace,           //
                           FinalizerTrait<T>::kCallback,   //
                           NameTrait<T>::GetName))         //
DISPATCH(true, false,                                      //
         EnsureGCInfoIndex(registered_index,               //
                           TraceTrait<T>::Trace,           //
                           FinalizerTrait<T>::kCallback))  //
DISPATCH(false, true,                                      //
         EnsureGCInfoIndex(registered_index,               //
                           TraceTrait<T>::Trace,           //
                           NameTrait<T>::GetName))         //
DISPATCH(false, false,                                     //
         EnsureGCInfoIndex(registered_index,               //
                           TraceTrait<T>::Trace))          //

#undef DISPATCH

// Trait determines how the garbage collector treats objects wrt. to traversing,
// finalization, and naming.
template <typename T>
struct GCInfoTrait final {
  V8_INLINE static GCInfoIndex Index() {
    static_assert(sizeof(T), "T must be fully defined");
    static std::atomic<GCInfoIndex>
        registered_index;  // Uses zero initialization.
    GCInfoIndex index = registered_index.load(std::memory_order_acquire);
    if (V8_UNLIKELY(!index)) {
      index = EnsureGCInfoIndexTrait::EnsureIndex<T>(registered_index);
      CPPGC_DCHECK(index != 0);
      CPPGC_DCHECK(index == registered_index.load(std::memory_order_acquire));
    }
    return index;
  }

  static constexpr bool CheckCallbacksAreDefined() {
    // No USE() macro available.
    (void)static_cast<TraceCallback>(TraceTrait<T>::Trace);
    (void)static_cast<FinalizationCallback>(FinalizerTrait<T>::kCallback);
    (void)static_cast<NameCallback>(NameTrait<T>::GetName);
    return true;
  }
};

// Fold types based on finalizer behavior. Note that finalizer characteristics
// align with trace behavior, i.e., destructors are virtual when trace methods
// are and vice versa.
template <typename T, typename ParentMostGarbageCollectedType>
struct GCInfoFolding final {
  static constexpr bool kHasVirtualDestructorAtBase =
      std::has_virtual_destructor<ParentMostGarbageCollectedType>::value;
  static constexpr bool kBothTypesAreTriviallyDestructible =
      std::is_trivially_destructible<ParentMostGarbageCollectedType>::value &&
      std::is_trivially_destructible<T>::value;
  static constexpr bool kHasCustomFinalizerDispatchAtBase =
      internal::HasFinalizeGarbageCollectedObject<
          ParentMostGarbageCollectedType>::value;
#ifdef CPPGC_SUPPORTS_OBJECT_NAMES
  static constexpr bool kWantsDetailedObjectNames = true;
#else   // !CPPGC_SUPPORTS_OBJECT_NAMES
  static constexpr bool kWantsDetailedObjectNames = false;
#endif  // !CPPGC_SUPPORTS_OBJECT_NAMES

  // Always true. Forces the compiler to resolve callbacks which ensures that
  // both modes don't break without requiring compiling a separate
  // configuration. Only a single GCInfo (for `ResultType` below) will actually
  // be instantiated but existence (and well-formedness) of all callbacks is
  // checked.
  static constexpr bool kCheckTypeGuardAlwaysTrue =
      GCInfoTrait<T>::CheckCallbacksAreDefined() &&
      GCInfoTrait<ParentMostGarbageCollectedType>::CheckCallbacksAreDefined();

  // Folding would regress name resolution when deriving names from C++
  // class names as it would just folds a name to the base class name.
  using ResultType =
      std::conditional_t<kCheckTypeGuardAlwaysTrue &&
                             (kHasVirtualDestructorAtBase ||
                              kBothTypesAreTriviallyDestructible ||
                              kHasCustomFinalizerDispatchAtBase) &&
                             !kWantsDetailedObjectNames,
                         ParentMostGarbageCollectedType, T>;
};

}  // namespace internal
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_INTERNAL_GC_INFO_H_
