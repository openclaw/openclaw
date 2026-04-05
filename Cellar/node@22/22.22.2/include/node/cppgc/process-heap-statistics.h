// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_PROCESS_HEAP_STATISTICS_H_
#define INCLUDE_CPPGC_PROCESS_HEAP_STATISTICS_H_

#include <atomic>
#include <cstddef>

#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {
namespace internal {
class ProcessHeapStatisticsUpdater;
}  // namespace internal

class V8_EXPORT ProcessHeapStatistics final {
 public:
  static size_t TotalAllocatedObjectSize() {
    return total_allocated_object_size_.load(std::memory_order_relaxed);
  }
  static size_t TotalAllocatedSpace() {
    return total_allocated_space_.load(std::memory_order_relaxed);
  }

 private:
  static std::atomic_size_t total_allocated_space_;
  static std::atomic_size_t total_allocated_object_size_;

  friend class internal::ProcessHeapStatisticsUpdater;
};

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_PROCESS_HEAP_STATISTICS_H_
