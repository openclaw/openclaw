// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_DEFAULT_PLATFORM_H_
#define INCLUDE_CPPGC_DEFAULT_PLATFORM_H_

#include <memory>

#include "cppgc/platform.h"
#include "libplatform/libplatform.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

/**
 * Platform provided by cppgc. Uses V8's DefaultPlatform provided by
 * libplatform internally. Exception: `GetForegroundTaskRunner()`, see below.
 */
class V8_EXPORT DefaultPlatform : public Platform {
 public:
  using IdleTaskSupport = v8::platform::IdleTaskSupport;
  explicit DefaultPlatform(
      int thread_pool_size = 0,
      IdleTaskSupport idle_task_support = IdleTaskSupport::kDisabled,
      std::unique_ptr<TracingController> tracing_controller = {})
      : v8_platform_(v8::platform::NewDefaultPlatform(
            thread_pool_size, idle_task_support,
            v8::platform::InProcessStackDumping::kDisabled,
            std::move(tracing_controller))) {}

  cppgc::PageAllocator* GetPageAllocator() override {
    return v8_platform_->GetPageAllocator();
  }

  double MonotonicallyIncreasingTime() override {
    return v8_platform_->MonotonicallyIncreasingTime();
  }

  std::shared_ptr<cppgc::TaskRunner> GetForegroundTaskRunner() override {
    // V8's default platform creates a new task runner when passed the
    // `v8::Isolate` pointer the first time. For non-default platforms this will
    // require getting the appropriate task runner.
    return v8_platform_->GetForegroundTaskRunner(kNoIsolate);
  }

  std::unique_ptr<cppgc::JobHandle> PostJob(
      cppgc::TaskPriority priority,
      std::unique_ptr<cppgc::JobTask> job_task) override {
    return v8_platform_->PostJob(priority, std::move(job_task));
  }

  TracingController* GetTracingController() override {
    return v8_platform_->GetTracingController();
  }

  v8::Platform* GetV8Platform() const { return v8_platform_.get(); }

 protected:
  static constexpr v8::Isolate* kNoIsolate = nullptr;

  std::unique_ptr<v8::Platform> v8_platform_;
};

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_DEFAULT_PLATFORM_H_
