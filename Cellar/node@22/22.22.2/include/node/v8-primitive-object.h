// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_PRIMITIVE_OBJECT_H_
#define INCLUDE_V8_PRIMITIVE_OBJECT_H_

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-object.h"        // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Isolate;

/**
 * A Number object (ECMA-262, 4.3.21).
 */
class V8_EXPORT NumberObject : public Object {
 public:
  static Local<Value> New(Isolate* isolate, double value);

  double ValueOf() const;

  V8_INLINE static NumberObject* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<NumberObject*>(value);
  }

 private:
  static void CheckCast(Value* obj);
};

/**
 * A BigInt object (https://tc39.github.io/proposal-bigint)
 */
class V8_EXPORT BigIntObject : public Object {
 public:
  static Local<Value> New(Isolate* isolate, int64_t value);

  Local<BigInt> ValueOf() const;

  V8_INLINE static BigIntObject* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<BigIntObject*>(value);
  }

 private:
  static void CheckCast(Value* obj);
};

/**
 * A Boolean object (ECMA-262, 4.3.15).
 */
class V8_EXPORT BooleanObject : public Object {
 public:
  static Local<Value> New(Isolate* isolate, bool value);

  bool ValueOf() const;

  V8_INLINE static BooleanObject* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<BooleanObject*>(value);
  }

 private:
  static void CheckCast(Value* obj);
};

/**
 * A String object (ECMA-262, 4.3.18).
 */
class V8_EXPORT StringObject : public Object {
 public:
  static Local<Value> New(Isolate* isolate, Local<String> value);

  Local<String> ValueOf() const;

  V8_INLINE static StringObject* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<StringObject*>(value);
  }

 private:
  static void CheckCast(Value* obj);
};

/**
 * A Symbol object (ECMA-262 edition 6).
 */
class V8_EXPORT SymbolObject : public Object {
 public:
  static Local<Value> New(Isolate* isolate, Local<Symbol> value);

  Local<Symbol> ValueOf() const;

  V8_INLINE static SymbolObject* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<SymbolObject*>(value);
  }

 private:
  static void CheckCast(Value* obj);
};

}  // namespace v8

#endif  // INCLUDE_V8_PRIMITIVE_OBJECT_H_
