// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_DATE_H_
#define INCLUDE_V8_DATE_H_

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-object.h"        // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;

/**
 * An instance of the built-in Date constructor (ECMA-262, 15.9).
 */
class V8_EXPORT Date : public Object {
 public:
  static V8_WARN_UNUSED_RESULT MaybeLocal<Value> New(Local<Context> context,
                                                     double time);

  /**
   * A specialization of Value::NumberValue that is more efficient
   * because we know the structure of this object.
   */
  double ValueOf() const;

  /**
   * Generates ISO string representation.
   */
  v8::Local<v8::String> ToISOString() const;

  V8_INLINE static Date* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Date*>(value);
  }

 private:
  static void CheckCast(Value* obj);
};

}  // namespace v8

#endif  // INCLUDE_V8_DATE_H_
