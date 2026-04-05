// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_TESTING_H_
#define INCLUDE_CPPGC_TESTING_H_

#include "cppgc/common.h"
#include "cppgc/macros.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

class HeapHandle;

/**
 * Namespace contains testing helpers.
 */
namespace testing {

/**
 * Overrides the state of the stack with the provided value. Parameters passed
 * to explicit garbage collection calls still take precedence. Must not be
 * nested.
 *
 * This scope is useful to make the garbage collector consider the stack when
 * tasks that invoke garbage collection (through the provided platform) contain
 * interesting pointers on its stack.
 */
class V8_EXPORT V8_NODISCARD OverrideEmbedderStackStateScope final {
  CPPGC_STACK_ALLOCATED();

 public:
  /**
   * Constructs a scoped object that automatically enters and leaves the scope.
   *
   * \param heap_handle The corresponding heap.
   */
  explicit OverrideEmbedderStackStateScope(HeapHandle& heap_handle,
                                           EmbedderStackState state);
  ~OverrideEmbedderStackStateScope();

  OverrideEmbedderStackStateScope(const OverrideEmbedderStackStateScope&) =
      delete;
  OverrideEmbedderStackStateScope& operator=(
      const OverrideEmbedderStackStateScope&) = delete;

 private:
  HeapHandle& heap_handle_;
};

/**
 * Testing interface for managed heaps that allows for controlling garbage
 * collection timings. Embedders should use this class when testing the
 * interaction of their code with incremental/concurrent garbage collection.
 */
class V8_EXPORT StandaloneTestingHeap final {
 public:
  explicit StandaloneTestingHeap(HeapHandle&);

  /**
   * Start an incremental garbage collection.
   */
  void StartGarbageCollection();

  /**
   * Perform an incremental step. This will also schedule concurrent steps if
   * needed.
   *
   * \param stack_state The state of the stack during the step.
   */
  bool PerformMarkingStep(EmbedderStackState stack_state);

  /**
   * Finalize the current garbage collection cycle atomically.
   * Assumes that garbage collection is in progress.
   *
   * \param stack_state The state of the stack for finalizing the garbage
   * collection cycle.
   */
  void FinalizeGarbageCollection(EmbedderStackState stack_state);

  /**
   * Toggle main thread marking on/off. Allows to stress concurrent marking
   * (e.g. to better detect data races).
   *
   * \param should_mark Denotes whether the main thread should contribute to
   * marking. Defaults to true.
   */
  void ToggleMainThreadMarking(bool should_mark);

  /**
   * Force enable compaction for the next garbage collection cycle.
   */
  void ForceCompactionForNextGarbageCollection();

 private:
  HeapHandle& heap_handle_;
};

V8_EXPORT bool IsHeapObjectOld(void*);

}  // namespace testing
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_TESTING_H_
