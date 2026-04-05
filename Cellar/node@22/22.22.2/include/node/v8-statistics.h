// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_STATISTICS_H_
#define INCLUDE_V8_STATISTICS_H_

#include <stddef.h>
#include <stdint.h>

#include <memory>
#include <utility>
#include <vector>

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-memory-span.h"   // NOLINT(build/include_directory)
#include "v8-promise.h"       // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;
class Isolate;

namespace internal {
class ReadOnlyHeap;
}  // namespace internal

/**
 * Controls how the default MeasureMemoryDelegate reports the result of
 * the memory measurement to JS. With kSummary only the total size is reported.
 * With kDetailed the result includes the size of each native context.
 */
enum class MeasureMemoryMode { kSummary, kDetailed };

/**
 * Controls how promptly a memory measurement request is executed.
 * By default the measurement is folded with the next scheduled GC which may
 * happen after a while and is forced after some timeout.
 * The kEager mode starts incremental GC right away and is useful for testing.
 * The kLazy mode does not force GC.
 */
enum class MeasureMemoryExecution { kDefault, kEager, kLazy };

/**
 * The delegate is used in Isolate::MeasureMemory API.
 *
 * It specifies the contexts that need to be measured and gets called when
 * the measurement is completed to report the results.
 *
 * Both MeasurementComplete() callbacks will be invoked on completion.
 * Each implementation of this class should hence implement only one of them,
 * and leave the other empty.
 */
class V8_EXPORT MeasureMemoryDelegate {
 public:
  virtual ~MeasureMemoryDelegate() = default;

  /**
   * Returns true if the size of the given context needs to be measured.
   */
  virtual bool ShouldMeasure(Local<Context> context) = 0;

  /** Holds the result of a memory measurement request. */
  struct Result {
    /**
     * Two spans of equal length: the first includes each context for which
     * ShouldMeasure returned true and that was not garbage collected while
     * the memory measurement was in progress; the second includes the size
     * of the respective context.
     */
    const MemorySpan<const Local<Context>>& contexts;
    const MemorySpan<const size_t>& sizes_in_bytes;

    /**
     * Total size of objects that were not attributed to any context (i.e. are
     * likely shared objects).
     */
    size_t unattributed_size_in_bytes;

    /** Total size of generated code for Wasm (shared across contexts). */
    size_t wasm_code_size_in_bytes;

    /** Total size of Wasm metadata (except code; shared across contexts). */
    size_t wasm_metadata_size_in_bytes;
  };

  /**
   * This function is called when memory measurement finishes.
   *
   * \param result the result of the measurement.
   */
  virtual void MeasurementComplete(Result result) {}

  /**
   * Returns a default delegate that resolves the given promise when
   * the memory measurement completes.
   *
   * \param isolate the current isolate
   * \param context the current context
   * \param promise_resolver the promise resolver that is given the
   *   result of the memory measurement.
   * \param mode the detail level of the result.
   */
  static std::unique_ptr<MeasureMemoryDelegate> Default(
      Isolate* isolate, Local<Context> context,
      Local<Promise::Resolver> promise_resolver, MeasureMemoryMode mode);
};

/**
 * Collection of shared per-process V8 memory information.
 *
 * Instances of this class can be passed to
 * v8::V8::GetSharedMemoryStatistics to get shared memory statistics from V8.
 */
class V8_EXPORT SharedMemoryStatistics {
 public:
  SharedMemoryStatistics();
  size_t read_only_space_size() { return read_only_space_size_; }
  size_t read_only_space_used_size() { return read_only_space_used_size_; }
  size_t read_only_space_physical_size() {
    return read_only_space_physical_size_;
  }

 private:
  size_t read_only_space_size_;
  size_t read_only_space_used_size_;
  size_t read_only_space_physical_size_;

  friend class V8;
  friend class internal::ReadOnlyHeap;
};

/**
 * Collection of V8 heap information.
 *
 * Instances of this class can be passed to v8::Isolate::GetHeapStatistics to
 * get heap statistics from V8.
 */
class V8_EXPORT HeapStatistics {
 public:
  HeapStatistics();
  size_t total_heap_size() { return total_heap_size_; }
  size_t total_heap_size_executable() { return total_heap_size_executable_; }
  size_t total_physical_size() { return total_physical_size_; }
  size_t total_available_size() { return total_available_size_; }
  size_t total_global_handles_size() { return total_global_handles_size_; }
  size_t used_global_handles_size() { return used_global_handles_size_; }
  size_t used_heap_size() { return used_heap_size_; }
  size_t heap_size_limit() { return heap_size_limit_; }
  size_t malloced_memory() { return malloced_memory_; }
  size_t external_memory() { return external_memory_; }
  size_t peak_malloced_memory() { return peak_malloced_memory_; }
  size_t number_of_native_contexts() { return number_of_native_contexts_; }
  size_t number_of_detached_contexts() { return number_of_detached_contexts_; }

  /**
   * Returns a 0/1 boolean, which signifies whether the V8 overwrite heap
   * garbage with a bit pattern.
   */
  size_t does_zap_garbage() { return does_zap_garbage_; }

 private:
  size_t total_heap_size_;
  size_t total_heap_size_executable_;
  size_t total_physical_size_;
  size_t total_available_size_;
  size_t used_heap_size_;
  size_t heap_size_limit_;
  size_t malloced_memory_;
  size_t external_memory_;
  size_t peak_malloced_memory_;
  bool does_zap_garbage_;
  size_t number_of_native_contexts_;
  size_t number_of_detached_contexts_;
  size_t total_global_handles_size_;
  size_t used_global_handles_size_;

  friend class V8;
  friend class Isolate;
};

class V8_EXPORT HeapSpaceStatistics {
 public:
  HeapSpaceStatistics();
  const char* space_name() { return space_name_; }
  size_t space_size() { return space_size_; }
  size_t space_used_size() { return space_used_size_; }
  size_t space_available_size() { return space_available_size_; }
  size_t physical_space_size() { return physical_space_size_; }

 private:
  const char* space_name_;
  size_t space_size_;
  size_t space_used_size_;
  size_t space_available_size_;
  size_t physical_space_size_;

  friend class Isolate;
};

class V8_EXPORT HeapObjectStatistics {
 public:
  HeapObjectStatistics();
  const char* object_type() { return object_type_; }
  const char* object_sub_type() { return object_sub_type_; }
  size_t object_count() { return object_count_; }
  size_t object_size() { return object_size_; }

 private:
  const char* object_type_;
  const char* object_sub_type_;
  size_t object_count_;
  size_t object_size_;

  friend class Isolate;
};

class V8_EXPORT HeapCodeStatistics {
 public:
  HeapCodeStatistics();
  size_t code_and_metadata_size() { return code_and_metadata_size_; }
  size_t bytecode_and_metadata_size() { return bytecode_and_metadata_size_; }
  size_t external_script_source_size() { return external_script_source_size_; }
  size_t cpu_profiler_metadata_size() { return cpu_profiler_metadata_size_; }

 private:
  size_t code_and_metadata_size_;
  size_t bytecode_and_metadata_size_;
  size_t external_script_source_size_;
  size_t cpu_profiler_metadata_size_;

  friend class Isolate;
};

}  // namespace v8

#endif  // INCLUDE_V8_STATISTICS_H_
