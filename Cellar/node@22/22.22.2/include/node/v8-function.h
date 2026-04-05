// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_FUNCTION_H_
#define INCLUDE_V8_FUNCTION_H_

#include <stddef.h>
#include <stdint.h>

#include "v8-function-callback.h"  // NOLINT(build/include_directory)
#include "v8-local-handle.h"       // NOLINT(build/include_directory)
#include "v8-message.h"            // NOLINT(build/include_directory)
#include "v8-object.h"             // NOLINT(build/include_directory)
#include "v8-template.h"           // NOLINT(build/include_directory)
#include "v8config.h"              // NOLINT(build/include_directory)

namespace v8 {

class Context;
class UnboundScript;

/**
 * A JavaScript function object (ECMA-262, 15.3).
 */
class V8_EXPORT Function : public Object {
 public:
  /**
   * Create a function in the current execution context
   * for a given FunctionCallback.
   */
  static MaybeLocal<Function> New(
      Local<Context> context, FunctionCallback callback,
      Local<Value> data = Local<Value>(), int length = 0,
      ConstructorBehavior behavior = ConstructorBehavior::kAllow,
      SideEffectType side_effect_type = SideEffectType::kHasSideEffect);

  V8_WARN_UNUSED_RESULT MaybeLocal<Object> NewInstance(
      Local<Context> context, int argc, Local<Value> argv[]) const;

  V8_WARN_UNUSED_RESULT MaybeLocal<Object> NewInstance(
      Local<Context> context) const {
    return NewInstance(context, 0, nullptr);
  }

  /**
   * When side effect checks are enabled, passing kHasNoSideEffect allows the
   * constructor to be invoked without throwing. Calls made within the
   * constructor are still checked.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Object> NewInstanceWithSideEffectType(
      Local<Context> context, int argc, Local<Value> argv[],
      SideEffectType side_effect_type = SideEffectType::kHasSideEffect) const;

  V8_WARN_UNUSED_RESULT MaybeLocal<Value> Call(Local<Context> context,
                                               Local<Value> recv, int argc,
                                               Local<Value> argv[]);

  void SetName(Local<String> name);
  Local<Value> GetName() const;

  V8_DEPRECATED("No direct replacement")
  MaybeLocal<UnboundScript> GetUnboundScript() const;

  /**
   * Name inferred from variable or property assignment of this function.
   * Used to facilitate debugging and profiling of JavaScript code written
   * in an OO style, where many functions are anonymous but are assigned
   * to object properties.
   */
  Local<Value> GetInferredName() const;

  /**
   * displayName if it is set, otherwise name if it is configured, otherwise
   * function name, otherwise inferred name.
   */
  Local<Value> GetDebugName() const;

  /**
   * Returns zero based line number of function body and
   * kLineOffsetNotFound if no information available.
   */
  int GetScriptLineNumber() const;
  /**
   * Returns zero based column number of function body and
   * kLineOffsetNotFound if no information available.
   */
  int GetScriptColumnNumber() const;

  /**
   * Returns zero based start position (character offset) of function body and
   * kLineOffsetNotFound if no information available.
   */
  int GetScriptStartPosition() const;

  /**
   * Returns scriptId.
   */
  int ScriptId() const;

  /**
   * Returns the original function if this function is bound, else returns
   * v8::Undefined.
   */
  Local<Value> GetBoundFunction() const;

  /**
   * Calls builtin Function.prototype.toString on this function.
   * This is different from Value::ToString() that may call a user-defined
   * toString() function, and different than Object::ObjectProtoToString() which
   * always serializes "[object Function]".
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<String> FunctionProtoToString(
      Local<Context> context);

  /**
   * Returns true if the function does nothing.
   * The function returns false on error.
   * Note that this function is experimental. Embedders should not rely on
   * this existing. We may remove this function in the future.
   */
  V8_WARN_UNUSED_RESULT bool Experimental_IsNopFunction() const;

  ScriptOrigin GetScriptOrigin() const;
  V8_INLINE static Function* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Function*>(value);
  }

  static const int kLineOffsetNotFound;

 private:
  Function();
  static void CheckCast(Value* obj);
};
}  // namespace v8

#endif  // INCLUDE_V8_FUNCTION_H_
