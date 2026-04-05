// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_PROMISE_H_
#define INCLUDE_V8_PROMISE_H_

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-object.h"        // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;

#ifndef V8_PROMISE_INTERNAL_FIELD_COUNT
// The number of required internal fields can be defined by embedder.
#define V8_PROMISE_INTERNAL_FIELD_COUNT 0
#endif

/**
 * An instance of the built-in Promise constructor (ES6 draft).
 */
class V8_EXPORT Promise : public Object {
 public:
  /**
   * State of the promise. Each value corresponds to one of the possible values
   * of the [[PromiseState]] field.
   */
  enum PromiseState { kPending, kFulfilled, kRejected };

  class V8_EXPORT Resolver : public Object {
   public:
    /**
     * Create a new resolver, along with an associated promise in pending state.
     */
    static V8_WARN_UNUSED_RESULT MaybeLocal<Resolver> New(
        Local<Context> context);

    /**
     * Extract the associated promise.
     */
    Local<Promise> GetPromise();

    /**
     * Resolve/reject the associated promise with a given value.
     * Ignored if the promise is no longer pending.
     */
    V8_WARN_UNUSED_RESULT Maybe<bool> Resolve(Local<Context> context,
                                              Local<Value> value);

    V8_WARN_UNUSED_RESULT Maybe<bool> Reject(Local<Context> context,
                                             Local<Value> value);

    V8_INLINE static Resolver* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
      CheckCast(value);
#endif
      return static_cast<Promise::Resolver*>(value);
    }

   private:
    Resolver();
    static void CheckCast(Value* obj);
  };

  /**
   * Register a resolution/rejection handler with a promise.
   * The handler is given the respective resolution/rejection value as
   * an argument. If the promise is already resolved/rejected, the handler is
   * invoked at the end of turn.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Promise> Catch(Local<Context> context,
                                                  Local<Function> handler);

  V8_WARN_UNUSED_RESULT MaybeLocal<Promise> Then(Local<Context> context,
                                                 Local<Function> handler);

  V8_WARN_UNUSED_RESULT MaybeLocal<Promise> Then(Local<Context> context,
                                                 Local<Function> on_fulfilled,
                                                 Local<Function> on_rejected);

  /**
   * Returns true if the promise has at least one derived promise, and
   * therefore resolve/reject handlers (including default handler).
   */
  bool HasHandler() const;

  /**
   * Returns the content of the [[PromiseResult]] field. The Promise must not
   * be pending.
   */
  Local<Value> Result();

  /**
   * Returns the value of the [[PromiseState]] field.
   */
  PromiseState State();

  /**
   * Marks this promise as handled to avoid reporting unhandled rejections.
   */
  void MarkAsHandled();

  /**
   * Marks this promise as silent to prevent pausing the debugger when the
   * promise is rejected.
   */
  void MarkAsSilent();

  V8_INLINE static Promise* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Promise*>(value);
  }

  static const int kEmbedderFieldCount = V8_PROMISE_INTERNAL_FIELD_COUNT;

 private:
  Promise();
  static void CheckCast(Value* obj);
};

/**
 * PromiseHook with type kInit is called when a new promise is
 * created. When a new promise is created as part of the chain in the
 * case of Promise.then or in the intermediate promises created by
 * Promise.{race, all}/AsyncFunctionAwait, we pass the parent promise
 * otherwise we pass undefined.
 *
 * PromiseHook with type kResolve is called at the beginning of
 * resolve or reject function defined by CreateResolvingFunctions.
 *
 * PromiseHook with type kBefore is called at the beginning of the
 * PromiseReactionJob.
 *
 * PromiseHook with type kAfter is called right at the end of the
 * PromiseReactionJob.
 */
enum class PromiseHookType { kInit, kResolve, kBefore, kAfter };

using PromiseHook = void (*)(PromiseHookType type, Local<Promise> promise,
                             Local<Value> parent);

// --- Promise Reject Callback ---
enum PromiseRejectEvent {
  kPromiseRejectWithNoHandler = 0,
  kPromiseHandlerAddedAfterReject = 1,
  kPromiseRejectAfterResolved = 2,
  kPromiseResolveAfterResolved = 3,
};

class PromiseRejectMessage {
 public:
  PromiseRejectMessage(Local<Promise> promise, PromiseRejectEvent event,
                       Local<Value> value)
      : promise_(promise), event_(event), value_(value) {}

  V8_INLINE Local<Promise> GetPromise() const { return promise_; }
  V8_INLINE PromiseRejectEvent GetEvent() const { return event_; }
  V8_INLINE Local<Value> GetValue() const { return value_; }

 private:
  Local<Promise> promise_;
  PromiseRejectEvent event_;
  Local<Value> value_;
};

using PromiseRejectCallback = void (*)(PromiseRejectMessage message);

}  // namespace v8

#endif  // INCLUDE_V8_PROMISE_H_
