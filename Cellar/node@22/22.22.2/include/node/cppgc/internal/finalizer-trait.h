// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_FINALIZER_TRAIT_H_
#define INCLUDE_CPPGC_INTERNAL_FINALIZER_TRAIT_H_

#include <type_traits>

#include "cppgc/type-traits.h"

namespace cppgc {
namespace internal {

using FinalizationCallback = void (*)(void*);

template <typename T, typename = void>
struct HasFinalizeGarbageCollectedObject : std::false_type {};

template <typename T>
struct HasFinalizeGarbageCollectedObject<
    T,
    std::void_t<decltype(std::declval<T>().FinalizeGarbageCollectedObject())>>
    : std::true_type {};

// The FinalizerTraitImpl specifies how to finalize objects.
template <typename T, bool isFinalized>
struct FinalizerTraitImpl;

template <typename T>
struct FinalizerTraitImpl<T, true> {
 private:
  // Dispatch to custom FinalizeGarbageCollectedObject().
  struct Custom {
    static void Call(void* obj) {
      static_cast<T*>(obj)->FinalizeGarbageCollectedObject();
    }
  };

  // Dispatch to regular destructor.
  struct Destructor {
    static void Call(void* obj) { static_cast<T*>(obj)->~T(); }
  };

  using FinalizeImpl =
      std::conditional_t<HasFinalizeGarbageCollectedObject<T>::value, Custom,
                         Destructor>;

 public:
  static void Finalize(void* obj) {
    static_assert(sizeof(T), "T must be fully defined");
    FinalizeImpl::Call(obj);
  }
};

template <typename T>
struct FinalizerTraitImpl<T, false> {
  static void Finalize(void* obj) {
    static_assert(sizeof(T), "T must be fully defined");
  }
};

// The FinalizerTrait is used to determine if a type requires finalization and
// what finalization means.
template <typename T>
struct FinalizerTrait {
 private:
  // Object has a finalizer if it has
  // - a custom FinalizeGarbageCollectedObject method, or
  // - a destructor.
  static constexpr bool kNonTrivialFinalizer =
      internal::HasFinalizeGarbageCollectedObject<T>::value ||
      !std::is_trivially_destructible<typename std::remove_cv<T>::type>::value;

  static void Finalize(void* obj) {
    internal::FinalizerTraitImpl<T, kNonTrivialFinalizer>::Finalize(obj);
  }

 public:
  static constexpr bool HasFinalizer() { return kNonTrivialFinalizer; }

  // The callback used to finalize an object of type T.
  static constexpr FinalizationCallback kCallback =
      kNonTrivialFinalizer ? Finalize : nullptr;
};

template <typename T>
constexpr FinalizationCallback FinalizerTrait<T>::kCallback;

}  // namespace internal
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_INTERNAL_FINALIZER_TRAIT_H_
