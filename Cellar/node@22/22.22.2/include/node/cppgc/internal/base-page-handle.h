// Copyright 2022 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_BASE_PAGE_HANDLE_H_
#define INCLUDE_CPPGC_INTERNAL_BASE_PAGE_HANDLE_H_

#include "cppgc/heap-handle.h"
#include "cppgc/internal/api-constants.h"
#include "cppgc/internal/logging.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {
namespace internal {

// The class is needed in the header to allow for fast access to HeapHandle in
// the write barrier.
class BasePageHandle {
 public:
  static V8_INLINE BasePageHandle* FromPayload(void* payload) {
    return reinterpret_cast<BasePageHandle*>(
        (reinterpret_cast<uintptr_t>(payload) &
         ~(api_constants::kPageSize - 1)) +
        api_constants::kGuardPageSize);
  }
  static V8_INLINE const BasePageHandle* FromPayload(const void* payload) {
    return FromPayload(const_cast<void*>(payload));
  }

  HeapHandle& heap_handle() { return heap_handle_; }
  const HeapHandle& heap_handle() const { return heap_handle_; }

 protected:
  explicit BasePageHandle(HeapHandle& heap_handle) : heap_handle_(heap_handle) {
    CPPGC_DCHECK(reinterpret_cast<uintptr_t>(this) % api_constants::kPageSize ==
                 api_constants::kGuardPageSize);
  }

  HeapHandle& heap_handle_;
};

}  // namespace internal
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_INTERNAL_BASE_PAGE_HANDLE_H_
