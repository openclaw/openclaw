// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_MICROTASKS_QUEUE_H_
#define INCLUDE_V8_MICROTASKS_QUEUE_H_

#include <stddef.h>

#include <memory>

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-microtask.h"     // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Function;

namespace internal {
class Isolate;
class MicrotaskQueue;
}  // namespace internal

/**
 * Represents the microtask queue, where microtasks are stored and processed.
 * https://html.spec.whatwg.org/multipage/webappapis.html#microtask-queue
 * https://html.spec.whatwg.org/multipage/webappapis.html#enqueuejob(queuename,-job,-arguments)
 * https://html.spec.whatwg.org/multipage/webappapis.html#perform-a-microtask-checkpoint
 *
 * A MicrotaskQueue instance may be associated to multiple Contexts by passing
 * it to Context::New(), and they can be detached by Context::DetachGlobal().
 * The embedder must keep the MicrotaskQueue instance alive until all associated
 * Contexts are gone or detached.
 *
 * Use the same instance of MicrotaskQueue for all Contexts that may access each
 * other synchronously. E.g. for Web embedding, use the same instance for all
 * origins that share the same URL scheme and eTLD+1.
 */
class V8_EXPORT MicrotaskQueue {
 public:
  /**
   * Creates an empty MicrotaskQueue instance.
   */
  static std::unique_ptr<MicrotaskQueue> New(
      Isolate* isolate, MicrotasksPolicy policy = MicrotasksPolicy::kAuto);

  virtual ~MicrotaskQueue() = default;

  /**
   * Enqueues the callback to the queue.
   */
  virtual void EnqueueMicrotask(Isolate* isolate,
                                Local<Function> microtask) = 0;

  /**
   * Enqueues the callback to the queue.
   */
  virtual void EnqueueMicrotask(v8::Isolate* isolate,
                                MicrotaskCallback callback,
                                void* data = nullptr) = 0;

  /**
   * Adds a callback to notify the embedder after microtasks were run. The
   * callback is triggered by explicit RunMicrotasks call or automatic
   * microtasks execution (see Isolate::SetMicrotasksPolicy).
   *
   * Callback will trigger even if microtasks were attempted to run,
   * but the microtasks queue was empty and no single microtask was actually
   * executed.
   *
   * Executing scripts inside the callback will not re-trigger microtasks and
   * the callback.
   */
  virtual void AddMicrotasksCompletedCallback(
      MicrotasksCompletedCallbackWithData callback, void* data = nullptr) = 0;

  /**
   * Removes callback that was installed by AddMicrotasksCompletedCallback.
   */
  virtual void RemoveMicrotasksCompletedCallback(
      MicrotasksCompletedCallbackWithData callback, void* data = nullptr) = 0;

  /**
   * Runs microtasks if no microtask is running on this MicrotaskQueue instance.
   */
  virtual void PerformCheckpoint(Isolate* isolate) = 0;

  /**
   * Returns true if a microtask is running on this MicrotaskQueue instance.
   */
  virtual bool IsRunningMicrotasks() const = 0;

  /**
   * Returns the current depth of nested MicrotasksScope that has
   * kRunMicrotasks.
   */
  virtual int GetMicrotasksScopeDepth() const = 0;

  MicrotaskQueue(const MicrotaskQueue&) = delete;
  MicrotaskQueue& operator=(const MicrotaskQueue&) = delete;

 private:
  friend class internal::MicrotaskQueue;
  MicrotaskQueue() = default;
};

/**
 * This scope is used to control microtasks when MicrotasksPolicy::kScoped
 * is used on Isolate. In this mode every non-primitive call to V8 should be
 * done inside some MicrotasksScope.
 * Microtasks are executed when topmost MicrotasksScope marked as kRunMicrotasks
 * exits.
 * kDoNotRunMicrotasks should be used to annotate calls not intended to trigger
 * microtasks.
 */
class V8_EXPORT V8_NODISCARD MicrotasksScope {
 public:
  enum Type { kRunMicrotasks, kDoNotRunMicrotasks };

  V8_DEPRECATE_SOON(
      "May be incorrect if context was created with non-default microtask "
      "queue")
  MicrotasksScope(Isolate* isolate, Type type);

  MicrotasksScope(Local<Context> context, Type type);
  MicrotasksScope(Isolate* isolate, MicrotaskQueue* microtask_queue, Type type);
  ~MicrotasksScope();

  /**
   * Runs microtasks if no kRunMicrotasks scope is currently active.
   */
  static void PerformCheckpoint(Isolate* isolate);

  /**
   * Returns current depth of nested kRunMicrotasks scopes.
   */
  static int GetCurrentDepth(Isolate* isolate);

  /**
   * Returns true while microtasks are being executed.
   */
  static bool IsRunningMicrotasks(Isolate* isolate);

  // Prevent copying.
  MicrotasksScope(const MicrotasksScope&) = delete;
  MicrotasksScope& operator=(const MicrotasksScope&) = delete;

 private:
  internal::Isolate* const i_isolate_;
  internal::MicrotaskQueue* const microtask_queue_;
  bool run_;
};

}  // namespace v8

#endif  // INCLUDE_V8_MICROTASKS_QUEUE_H_
