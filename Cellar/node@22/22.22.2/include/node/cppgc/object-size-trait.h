// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_OBJECT_SIZE_TRAIT_H_
#define INCLUDE_CPPGC_OBJECT_SIZE_TRAIT_H_

#include <cstddef>

#include "cppgc/type-traits.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

namespace internal {

struct V8_EXPORT BaseObjectSizeTrait {
 protected:
  static size_t GetObjectSizeForGarbageCollected(const void*);
  static size_t GetObjectSizeForGarbageCollectedMixin(const void*);
};

}  // namespace internal

namespace subtle {

/**
 * Trait specifying how to get the size of an object that was allocated using
 * `MakeGarbageCollected()`. Also supports querying the size with an inner
 * pointer to a mixin.
 */
template <typename T, bool = IsGarbageCollectedMixinTypeV<T>>
struct ObjectSizeTrait;

template <typename T>
struct ObjectSizeTrait<T, false> : cppgc::internal::BaseObjectSizeTrait {
  static_assert(sizeof(T), "T must be fully defined");
  static_assert(IsGarbageCollectedTypeV<T>,
                "T must be of type GarbageCollected or GarbageCollectedMixin");

  static size_t GetSize(const T& object) {
    return GetObjectSizeForGarbageCollected(&object);
  }
};

template <typename T>
struct ObjectSizeTrait<T, true> : cppgc::internal::BaseObjectSizeTrait {
  static_assert(sizeof(T), "T must be fully defined");

  static size_t GetSize(const T& object) {
    return GetObjectSizeForGarbageCollectedMixin(&object);
  }
};

}  // namespace subtle
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_OBJECT_SIZE_TRAIT_H_
