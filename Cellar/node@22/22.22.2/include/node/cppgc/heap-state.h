// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_HEAP_STATE_H_
#define INCLUDE_CPPGC_HEAP_STATE_H_

#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

class HeapHandle;

namespace subtle {

/**
 * Helpers to peek into heap-internal state.
 */
class V8_EXPORT HeapState final {
 public:
  /**
   * Returns whether the garbage collector is marking. This API is experimental
   * and is expected to be removed in future.
   *
   * \param heap_handle The corresponding heap.
   * \returns true if the garbage collector is currently marking, and false
   *   otherwise.
   */
  static bool IsMarking(const HeapHandle& heap_handle);

  /*
   * Returns whether the garbage collector is sweeping. This API is experimental
   * and is expected to be removed in future.
   *
   * \param heap_handle The corresponding heap.
   * \returns true if the garbage collector is currently sweeping, and false
   *   otherwise.
   */
  static bool IsSweeping(const HeapHandle& heap_handle);

  /*
   * Returns whether the garbage collector is currently sweeping on the thread
   * owning this heap. This API allows the caller to determine whether it has
   * been called from a destructor of a managed object. This API is experimental
   * and may be removed in future.
   *
   * \param heap_handle The corresponding heap.
   * \returns true if the garbage collector is currently sweeping on this
   *   thread, and false otherwise.
   */
  static bool IsSweepingOnOwningThread(const HeapHandle& heap_handle);

  /**
   * Returns whether the garbage collector is in the atomic pause, i.e., the
   * mutator is stopped from running. This API is experimental and is expected
   * to be removed in future.
   *
   * \param heap_handle The corresponding heap.
   * \returns true if the garbage collector is currently in the atomic pause,
   *   and false otherwise.
   */
  static bool IsInAtomicPause(const HeapHandle& heap_handle);

  /**
   * Returns whether the last garbage collection was finalized conservatively
   * (i.e., with a non-empty stack). This API is experimental and is expected to
   * be removed in future.
   *
   * \param heap_handle The corresponding heap.
   * \returns true if the last garbage collection was finalized conservatively,
   * and false otherwise.
   */
  static bool PreviousGCWasConservative(const HeapHandle& heap_handle);

 private:
  HeapState() = delete;
};

}  // namespace subtle
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_HEAP_STATE_H_
