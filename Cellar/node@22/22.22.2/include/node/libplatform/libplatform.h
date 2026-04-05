// Copyright 2014 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef V8_LIBPLATFORM_LIBPLATFORM_H_
#define V8_LIBPLATFORM_LIBPLATFORM_H_

#include <memory>

#include "libplatform/libplatform-export.h"
#include "libplatform/v8-tracing.h"
#include "v8-platform.h"  // NOLINT(build/include_directory)
#include "v8config.h"     // NOLINT(build/include_directory)

namespace v8 {
namespace platform {

enum class IdleTaskSupport { kDisabled, kEnabled };
enum class InProcessStackDumping { kDisabled, kEnabled };

enum class MessageLoopBehavior : bool {
  kDoNotWait = false,
  kWaitForWork = true
};

enum class PriorityMode : bool { kDontApply, kApply };

/**
 * Returns a new instance of the default v8::Platform implementation.
 *
 * The caller will take ownership of the returned pointer. |thread_pool_size|
 * is the number of worker threads to allocate for background jobs. If a value
 * of zero is passed, a suitable default based on the current number of
 * processors online will be chosen.
 * If |idle_task_support| is enabled then the platform will accept idle
 * tasks (IdleTasksEnabled will return true) and will rely on the embedder
 * calling v8::platform::RunIdleTasks to process the idle tasks.
 * If |tracing_controller| is nullptr, the default platform will create a
 * v8::platform::TracingController instance and use it.
 * If |priority_mode| is PriorityMode::kApply, the default platform will use
 * multiple task queues executed by threads different system-level priorities
 * (where available) to schedule tasks.
 */
V8_PLATFORM_EXPORT std::unique_ptr<v8::Platform> NewDefaultPlatform(
    int thread_pool_size = 0,
    IdleTaskSupport idle_task_support = IdleTaskSupport::kDisabled,
    InProcessStackDumping in_process_stack_dumping =
        InProcessStackDumping::kDisabled,
    std::unique_ptr<v8::TracingController> tracing_controller = {},
    PriorityMode priority_mode = PriorityMode::kDontApply);

/**
 * The same as NewDefaultPlatform but disables the worker thread pool.
 * It must be used with the --single-threaded V8 flag.
 */
V8_PLATFORM_EXPORT std::unique_ptr<v8::Platform>
NewSingleThreadedDefaultPlatform(
    IdleTaskSupport idle_task_support = IdleTaskSupport::kDisabled,
    InProcessStackDumping in_process_stack_dumping =
        InProcessStackDumping::kDisabled,
    std::unique_ptr<v8::TracingController> tracing_controller = {});

/**
 * Returns a new instance of the default v8::JobHandle implementation.
 *
 * The job will be executed by spawning up to |num_worker_threads| many worker
 * threads on the provided |platform| with the given |priority|.
 */
V8_PLATFORM_EXPORT std::unique_ptr<v8::JobHandle> NewDefaultJobHandle(
    v8::Platform* platform, v8::TaskPriority priority,
    std::unique_ptr<v8::JobTask> job_task, size_t num_worker_threads);

/**
 * Pumps the message loop for the given isolate.
 *
 * The caller has to make sure that this is called from the right thread.
 * Returns true if a task was executed, and false otherwise. If the call to
 * PumpMessageLoop is nested within another call to PumpMessageLoop, only
 * nestable tasks may run. Otherwise, any task may run. Unless requested through
 * the |behavior| parameter, this call does not block if no task is pending. The
 * |platform| has to be created using |NewDefaultPlatform|.
 */
V8_PLATFORM_EXPORT bool PumpMessageLoop(
    v8::Platform* platform, v8::Isolate* isolate,
    MessageLoopBehavior behavior = MessageLoopBehavior::kDoNotWait);

/**
 * Runs pending idle tasks for at most |idle_time_in_seconds| seconds.
 *
 * The caller has to make sure that this is called from the right thread.
 * This call does not block if no task is pending. The |platform| has to be
 * created using |NewDefaultPlatform|.
 */
V8_PLATFORM_EXPORT void RunIdleTasks(v8::Platform* platform,
                                     v8::Isolate* isolate,
                                     double idle_time_in_seconds);

/**
 * Notifies the given platform about the Isolate getting deleted soon. Has to be
 * called for all Isolates which are deleted - unless we're shutting down the
 * platform.
 *
 * The |platform| has to be created using |NewDefaultPlatform|.
 *
 */
V8_PLATFORM_EXPORT void NotifyIsolateShutdown(v8::Platform* platform,
                                              Isolate* isolate);

}  // namespace platform
}  // namespace v8

#endif  // V8_LIBPLATFORM_LIBPLATFORM_H_
