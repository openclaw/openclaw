// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_VALUE_H_
#define INCLUDE_V8_VALUE_H_

#include "v8-data.h"          // NOLINT(build/include_directory)
#include "v8-internal.h"      // NOLINT(build/include_directory)
#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-maybe.h"         // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

/**
 * The v8 JavaScript engine.
 */
namespace v8 {

class Primitive;
class Numeric;
class BigInt;
class Int32;
class Integer;
class Number;
class Object;
class String;
class Uint32;

/**
 * The superclass of all JavaScript values and objects.
 */
class V8_EXPORT Value : public Data {
 public:
  /**
   * Returns true if this value is the undefined value.  See ECMA-262
   * 4.3.10.
   *
   * This is equivalent to `value === undefined` in JS.
   */
  V8_INLINE bool IsUndefined() const;

  /**
   * Returns true if this value is the null value.  See ECMA-262
   * 4.3.11.
   *
   * This is equivalent to `value === null` in JS.
   */
  V8_INLINE bool IsNull() const;

  /**
   * Returns true if this value is either the null or the undefined value.
   * See ECMA-262
   * 4.3.11. and 4.3.12
   *
   * This is equivalent to `value == null` in JS.
   */
  V8_INLINE bool IsNullOrUndefined() const;

  /**
   * Returns true if this value is true.
   *
   * This is not the same as `BooleanValue()`. The latter performs a
   * conversion to boolean, i.e. the result of `Boolean(value)` in JS, whereas
   * this checks `value === true`.
   */
  V8_INLINE bool IsTrue() const;

  /**
   * Returns true if this value is false.
   *
   * This is not the same as `!BooleanValue()`. The latter performs a
   * conversion to boolean, i.e. the result of `!Boolean(value)` in JS, whereas
   * this checks `value === false`.
   */
  V8_INLINE bool IsFalse() const;

  /**
   * Returns true if this value is a symbol or a string.
   *
   * This is equivalent to
   * `typeof value === 'string' || typeof value === 'symbol'` in JS.
   */
  bool IsName() const;

  /**
   * Returns true if this value is an instance of the String type.
   * See ECMA-262 8.4.
   *
   * This is equivalent to `typeof value === 'string'` in JS.
   */
  V8_INLINE bool IsString() const;

  /**
   * Returns true if this value is a symbol.
   *
   * This is equivalent to `typeof value === 'symbol'` in JS.
   */
  bool IsSymbol() const;

  /**
   * Returns true if this value is a function.
   *
   * This is equivalent to `typeof value === 'function'` in JS.
   */
  bool IsFunction() const;

  /**
   * Returns true if this value is an array. Note that it will return false for
   * an Proxy for an array.
   */
  bool IsArray() const;

  /**
   * Returns true if this value is an object.
   */
  bool IsObject() const;

  /**
   * Returns true if this value is a bigint.
   *
   * This is equivalent to `typeof value === 'bigint'` in JS.
   */
  bool IsBigInt() const;

  /**
   * Returns true if this value is boolean.
   *
   * This is equivalent to `typeof value === 'boolean'` in JS.
   */
  bool IsBoolean() const;

  /**
   * Returns true if this value is a number.
   *
   * This is equivalent to `typeof value === 'number'` in JS.
   */
  bool IsNumber() const;

  /**
   * Returns true if this value is an `External` object.
   */
  bool IsExternal() const;

  /**
   * Returns true if this value is a 32-bit signed integer.
   */
  bool IsInt32() const;

  /**
   * Returns true if this value is a 32-bit unsigned integer.
   */
  bool IsUint32() const;

  /**
   * Returns true if this value is a Date.
   */
  bool IsDate() const;

  /**
   * Returns true if this value is an Arguments object.
   */
  bool IsArgumentsObject() const;

  /**
   * Returns true if this value is a BigInt object.
   */
  bool IsBigIntObject() const;

  /**
   * Returns true if this value is a Boolean object.
   */
  bool IsBooleanObject() const;

  /**
   * Returns true if this value is a Number object.
   */
  bool IsNumberObject() const;

  /**
   * Returns true if this value is a String object.
   */
  bool IsStringObject() const;

  /**
   * Returns true if this value is a Symbol object.
   */
  bool IsSymbolObject() const;

  /**
   * Returns true if this value is a NativeError.
   */
  bool IsNativeError() const;

  /**
   * Returns true if this value is a RegExp.
   */
  bool IsRegExp() const;

  /**
   * Returns true if this value is an async function.
   */
  bool IsAsyncFunction() const;

  /**
   * Returns true if this value is a Generator function.
   */
  bool IsGeneratorFunction() const;

  /**
   * Returns true if this value is a Generator object (iterator).
   */
  bool IsGeneratorObject() const;

  /**
   * Returns true if this value is a Promise.
   */
  bool IsPromise() const;

  /**
   * Returns true if this value is a Map.
   */
  bool IsMap() const;

  /**
   * Returns true if this value is a Set.
   */
  bool IsSet() const;

  /**
   * Returns true if this value is a Map Iterator.
   */
  bool IsMapIterator() const;

  /**
   * Returns true if this value is a Set Iterator.
   */
  bool IsSetIterator() const;

  /**
   * Returns true if this value is a WeakMap.
   */
  bool IsWeakMap() const;

  /**
   * Returns true if this value is a WeakSet.
   */
  bool IsWeakSet() const;

  /**
   * Returns true if this value is a WeakRef.
   */
  bool IsWeakRef() const;

  /**
   * Returns true if this value is an ArrayBuffer.
   */
  bool IsArrayBuffer() const;

  /**
   * Returns true if this value is an ArrayBufferView.
   */
  bool IsArrayBufferView() const;

  /**
   * Returns true if this value is one of TypedArrays.
   */
  bool IsTypedArray() const;

  /**
   * Returns true if this value is an Uint8Array.
   */
  bool IsUint8Array() const;

  /**
   * Returns true if this value is an Uint8ClampedArray.
   */
  bool IsUint8ClampedArray() const;

  /**
   * Returns true if this value is an Int8Array.
   */
  bool IsInt8Array() const;

  /**
   * Returns true if this value is an Uint16Array.
   */
  bool IsUint16Array() const;

  /**
   * Returns true if this value is an Int16Array.
   */
  bool IsInt16Array() const;

  /**
   * Returns true if this value is an Uint32Array.
   */
  bool IsUint32Array() const;

  /**
   * Returns true if this value is an Int32Array.
   */
  bool IsInt32Array() const;

  /**
   * Returns true if this value is a Float16Array.
   */
  bool IsFloat16Array() const;

  /**
   * Returns true if this value is a Float32Array.
   */
  bool IsFloat32Array() const;

  /**
   * Returns true if this value is a Float64Array.
   */
  bool IsFloat64Array() const;

  /**
   * Returns true if this value is a BigInt64Array.
   */
  bool IsBigInt64Array() const;

  /**
   * Returns true if this value is a BigUint64Array.
   */
  bool IsBigUint64Array() const;

  /**
   * Returns true if this value is a DataView.
   */
  bool IsDataView() const;

  /**
   * Returns true if this value is a SharedArrayBuffer.
   */
  bool IsSharedArrayBuffer() const;

  /**
   * Returns true if this value is a JavaScript Proxy.
   */
  bool IsProxy() const;

  /**
   * Returns true if this value is a WasmMemoryObject.
   */
  bool IsWasmMemoryObject() const;

  /**
   * Returns true if this value is a WasmModuleObject.
   */
  bool IsWasmModuleObject() const;

  /**
   * Returns true if this value is the WasmNull object.
   */
  bool IsWasmNull() const;

  /**
   * Returns true if the value is a Module Namespace Object.
   */
  bool IsModuleNamespaceObject() const;

  /**
   * Perform `ToPrimitive(value)` as specified in:
   * https://tc39.es/ecma262/#sec-toprimitive.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Primitive> ToPrimitive(
      Local<Context> context) const;
  /**
   * Perform `ToNumeric(value)` as specified in:
   * https://tc39.es/ecma262/#sec-tonumeric.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Numeric> ToNumeric(
      Local<Context> context) const;
  /**
   * Perform the equivalent of `BigInt(value)` in JS.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<BigInt> ToBigInt(
      Local<Context> context) const;
  /**
   * Perform the equivalent of `Number(value)` in JS.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Number> ToNumber(
      Local<Context> context) const;
  /**
   * Perform the equivalent of `String(value)` in JS.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<String> ToString(
      Local<Context> context) const;
  /**
   * Provide a string representation of this value usable for debugging.
   * This operation has no observable side effects and will succeed
   * unless e.g. execution is being terminated.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<String> ToDetailString(
      Local<Context> context) const;
  /**
   * Perform the equivalent of `Tagged<Object>(value)` in JS.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Object> ToObject(
      Local<Context> context) const;
  /**
   * Perform the equivalent of `Number(value)` in JS and convert the result
   * to an integer. Negative values are rounded up, positive values are rounded
   * down. NaN is converted to 0. Infinite values yield undefined results.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Integer> ToInteger(
      Local<Context> context) const;
  /**
   * Perform the equivalent of `Number(value)` in JS and convert the result
   * to an unsigned 32-bit integer by performing the steps in
   * https://tc39.es/ecma262/#sec-touint32.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Uint32> ToUint32(
      Local<Context> context) const;
  /**
   * Perform the equivalent of `Number(value)` in JS and convert the result
   * to a signed 32-bit integer by performing the steps in
   * https://tc39.es/ecma262/#sec-toint32.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Int32> ToInt32(Local<Context> context) const;

  /**
   * Perform the equivalent of `Boolean(value)` in JS. This can never fail.
   */
  Local<Boolean> ToBoolean(Isolate* isolate) const;

  /**
   * Attempts to convert a string to an array index.
   * Returns an empty handle if the conversion fails.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Uint32> ToArrayIndex(
      Local<Context> context) const;

  /** Returns the equivalent of `ToBoolean()->Value()`. */
  bool BooleanValue(Isolate* isolate) const;

  /** Returns the equivalent of `ToNumber()->Value()`. */
  V8_WARN_UNUSED_RESULT Maybe<double> NumberValue(Local<Context> context) const;
  /** Returns the equivalent of `ToInteger()->Value()`. */
  V8_WARN_UNUSED_RESULT Maybe<int64_t> IntegerValue(
      Local<Context> context) const;
  /** Returns the equivalent of `ToUint32()->Value()`. */
  V8_WARN_UNUSED_RESULT Maybe<uint32_t> Uint32Value(
      Local<Context> context) const;
  /** Returns the equivalent of `ToInt32()->Value()`. */
  V8_WARN_UNUSED_RESULT Maybe<int32_t> Int32Value(Local<Context> context) const;

  /** JS == */
  V8_WARN_UNUSED_RESULT Maybe<bool> Equals(Local<Context> context,
                                           Local<Value> that) const;
  bool StrictEquals(Local<Value> that) const;
  bool SameValue(Local<Value> that) const;

  template <class T>
  V8_INLINE static Value* Cast(T* value) {
    return static_cast<Value*>(value);
  }

  Local<String> TypeOf(Isolate*);

  Maybe<bool> InstanceOf(Local<Context> context, Local<Object> object);

 private:
  V8_INLINE bool QuickIsUndefined() const;
  V8_INLINE bool QuickIsNull() const;
  V8_INLINE bool QuickIsNullOrUndefined() const;
#if V8_STATIC_ROOTS_BOOL
  V8_INLINE bool QuickIsTrue() const;
  V8_INLINE bool QuickIsFalse() const;
#endif  // V8_STATIC_ROOTS_BOOL
  V8_INLINE bool QuickIsString() const;
  bool FullIsUndefined() const;
  bool FullIsNull() const;
  bool FullIsTrue() const;
  bool FullIsFalse() const;
  bool FullIsString() const;

  static void CheckCast(Data* that);
};

/**
 * Can be used to avoid repeated expensive type checks for groups of objects
 * that are expected to be similar (e.g. when Blink converts a bunch of
 * JavaScript objects to "ScriptWrappable" after a "HasInstance" check) by
 * making use of V8-internal "hidden classes". An object that has passed the
 * full check can be remembered via {Update}; further objects can be queried
 * using {Matches}.
 * Note that the answer will be conservative/"best-effort": when {Matches}
 * returns true, then the {candidate} can be relied upon to have the same
 * shape/constructor/prototype/etc. as the {baseline}. Otherwise, no reliable
 * statement can be made (the objects might still have indistinguishable shapes
 * for all intents and purposes, but this mechanism, being optimized for speed,
 * couldn't determine that quickly).
 */
class V8_EXPORT TypecheckWitness {
 public:
  explicit TypecheckWitness(Isolate* isolate);

  /**
   * Checks whether {candidate} can cheaply be identified as being "similar"
   * to the {baseline} that was passed to {Update} earlier.
   * It's safe to call this on an uninitialized {TypecheckWitness} instance:
   * it will then return {false} for any input.
   */
  V8_INLINE bool Matches(Local<Value> candidate) const;

  /**
   * Remembers a new baseline for future {Matches} queries.
   */
  void Update(Local<Value> baseline);

 private:
  Local<Data> cached_map_;
};

template <>
V8_INLINE Value* Value::Cast(Data* value) {
#ifdef V8_ENABLE_CHECKS
  CheckCast(value);
#endif
  return static_cast<Value*>(value);
}

bool Value::IsUndefined() const {
#ifdef V8_ENABLE_CHECKS
  return FullIsUndefined();
#else
  return QuickIsUndefined();
#endif
}

bool Value::QuickIsUndefined() const {
  using A = internal::Address;
  using I = internal::Internals;
  A obj = internal::ValueHelper::ValueAsAddress(this);
#if V8_STATIC_ROOTS_BOOL
  return I::is_identical(obj, I::StaticReadOnlyRoot::kUndefinedValue);
#else
  if (!I::HasHeapObjectTag(obj)) return false;
  if (I::GetInstanceType(obj) != I::kOddballType) return false;
  return (I::GetOddballKind(obj) == I::kUndefinedOddballKind);
#endif  // V8_STATIC_ROOTS_BOOL
}

bool Value::IsNull() const {
#ifdef V8_ENABLE_CHECKS
  return FullIsNull();
#else
  return QuickIsNull();
#endif
}

bool Value::QuickIsNull() const {
  using A = internal::Address;
  using I = internal::Internals;
  A obj = internal::ValueHelper::ValueAsAddress(this);
#if V8_STATIC_ROOTS_BOOL
  return I::is_identical(obj, I::StaticReadOnlyRoot::kNullValue);
#else
  if (!I::HasHeapObjectTag(obj)) return false;
  if (I::GetInstanceType(obj) != I::kOddballType) return false;
  return (I::GetOddballKind(obj) == I::kNullOddballKind);
#endif  // V8_STATIC_ROOTS_BOOL
}

bool Value::IsNullOrUndefined() const {
#ifdef V8_ENABLE_CHECKS
  return FullIsNull() || FullIsUndefined();
#else
  return QuickIsNullOrUndefined();
#endif
}

bool Value::QuickIsNullOrUndefined() const {
#if V8_STATIC_ROOTS_BOOL
  return QuickIsNull() || QuickIsUndefined();
#else
  using A = internal::Address;
  using I = internal::Internals;
  A obj = internal::ValueHelper::ValueAsAddress(this);
  if (!I::HasHeapObjectTag(obj)) return false;
  if (I::GetInstanceType(obj) != I::kOddballType) return false;
  int kind = I::GetOddballKind(obj);
  return kind == I::kNullOddballKind || kind == I::kUndefinedOddballKind;
#endif  // V8_STATIC_ROOTS_BOOL
}

bool Value::IsTrue() const {
#if V8_STATIC_ROOTS_BOOL && !defined(V8_ENABLE_CHECKS)
  return QuickIsTrue();
#else
  return FullIsTrue();
#endif
}

#if V8_STATIC_ROOTS_BOOL
bool Value::QuickIsTrue() const {
  using A = internal::Address;
  using I = internal::Internals;
  A obj = internal::ValueHelper::ValueAsAddress(this);
  return I::is_identical(obj, I::StaticReadOnlyRoot::kTrueValue);
}
#endif  // V8_STATIC_ROOTS_BOOL

bool Value::IsFalse() const {
#if V8_STATIC_ROOTS_BOOL && !defined(V8_ENABLE_CHECKS)
  return QuickIsFalse();
#else
  return FullIsFalse();
#endif
}

#if V8_STATIC_ROOTS_BOOL
bool Value::QuickIsFalse() const {
  using A = internal::Address;
  using I = internal::Internals;
  A obj = internal::ValueHelper::ValueAsAddress(this);
  return I::is_identical(obj, I::StaticReadOnlyRoot::kFalseValue);
}
#endif  // V8_STATIC_ROOTS_BOOL

bool Value::IsString() const {
#ifdef V8_ENABLE_CHECKS
  return FullIsString();
#else
  return QuickIsString();
#endif
}

bool Value::QuickIsString() const {
  using A = internal::Address;
  using I = internal::Internals;
  A obj = internal::ValueHelper::ValueAsAddress(this);
  if (!I::HasHeapObjectTag(obj)) return false;
#if V8_STATIC_ROOTS_BOOL && !V8_MAP_PACKING
  return I::CheckInstanceMapRange(obj, I::StaticReadOnlyRoot::kFirstStringMap,
                                  I::StaticReadOnlyRoot::kLastStringMap);
#else
  return (I::GetInstanceType(obj) < I::kFirstNonstringType);
#endif  // V8_STATIC_ROOTS_BOOL
}

bool TypecheckWitness::Matches(Local<Value> candidate) const {
  internal::Address obj = internal::ValueHelper::ValueAsAddress(*candidate);
  internal::Address obj_map = internal::Internals::LoadMap(obj);
  internal::Address cached =
      internal::ValueHelper::ValueAsAddress(*cached_map_);
  return obj_map == cached;
}

}  // namespace v8

#endif  // INCLUDE_V8_VALUE_H_
