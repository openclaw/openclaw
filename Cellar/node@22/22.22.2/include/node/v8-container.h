// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_CONTAINER_H_
#define INCLUDE_V8_CONTAINER_H_

#include <stddef.h>
#include <stdint.h>

#include <functional>

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-object.h"        // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;
class Isolate;

/**
 * An instance of the built-in array constructor (ECMA-262, 15.4.2).
 */
class V8_EXPORT Array : public Object {
 public:
  uint32_t Length() const;

  /**
   * Creates a JavaScript array with the given length. If the length
   * is negative the returned array will have length 0.
   */
  static Local<Array> New(Isolate* isolate, int length = 0);

  /**
   * Creates a JavaScript array out of a Local<Value> array in C++
   * with a known length.
   */
  static Local<Array> New(Isolate* isolate, Local<Value>* elements,
                          size_t length);
  V8_INLINE static Array* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Array*>(value);
  }

  /**
   * Creates a JavaScript array from a provided callback.
   *
   * \param context The v8::Context to create the array in.
   * \param length The length of the array to be created.
   * \param next_value_callback The callback that is invoked to retrieve
   *     elements for the array. The embedder can signal that the array
   *     initialization should be aborted by throwing an exception and returning
   *     an empty MaybeLocal.
   * \returns The v8::Array if all elements were constructed successfully and an
   *     empty MaybeLocal otherwise.
   */
  static MaybeLocal<Array> New(
      Local<Context> context, size_t length,
      std::function<MaybeLocal<v8::Value>()> next_value_callback);

  enum class CallbackResult {
    kException,
    kBreak,
    kContinue,
  };
  using IterationCallback = CallbackResult (*)(uint32_t index,
                                               Local<Value> element,
                                               void* data);

  /**
   * Calls {callback} for every element of this array, passing {callback_data}
   * as its {data} parameter.
   * This function will typically be faster than calling {Get()} repeatedly.
   * As a consequence of being optimized for low overhead, the provided
   * callback must adhere to the following restrictions:
   *  - It must not allocate any V8 objects and continue iterating; it may
   *    allocate (e.g. an error message/object) and then immediately terminate
   *    the iteration.
   *  - It must not modify the array being iterated.
   *  - It must not call back into V8 (unless it can guarantee that such a
   *    call does not violate the above restrictions, which is difficult).
   *  - The {Local<Value> element} must not "escape", i.e. must not be assigned
   *    to any other {Local}. Creating a {Global} from it, or updating a
   *    v8::TypecheckWitness with it, is safe.
   * These restrictions may be lifted in the future if use cases arise that
   * justify a slower but more robust implementation.
   *
   * Returns {Nothing} on exception; use a {TryCatch} to catch and handle this
   * exception.
   * When the {callback} returns {kException}, iteration is terminated
   * immediately, returning {Nothing}. By returning {kBreak}, the callback
   * can request non-exceptional early termination of the iteration.
   */
  Maybe<void> Iterate(Local<Context> context, IterationCallback callback,
                      void* callback_data);

 private:
  Array();
  static void CheckCast(Value* obj);
};

/**
 * An instance of the built-in Map constructor (ECMA-262, 6th Edition, 23.1.1).
 */
class V8_EXPORT Map : public Object {
 public:
  size_t Size() const;
  void Clear();
  V8_WARN_UNUSED_RESULT MaybeLocal<Value> Get(Local<Context> context,
                                              Local<Value> key);
  V8_WARN_UNUSED_RESULT MaybeLocal<Map> Set(Local<Context> context,
                                            Local<Value> key,
                                            Local<Value> value);
  V8_WARN_UNUSED_RESULT Maybe<bool> Has(Local<Context> context,
                                        Local<Value> key);
  V8_WARN_UNUSED_RESULT Maybe<bool> Delete(Local<Context> context,
                                           Local<Value> key);

  /**
   * Returns an array of length Size() * 2, where index N is the Nth key and
   * index N + 1 is the Nth value.
   */
  Local<Array> AsArray() const;

  /**
   * Creates a new empty Map.
   */
  static Local<Map> New(Isolate* isolate);

  V8_INLINE static Map* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Map*>(value);
  }

 private:
  Map();
  static void CheckCast(Value* obj);
};

/**
 * An instance of the built-in Set constructor (ECMA-262, 6th Edition, 23.2.1).
 */
class V8_EXPORT Set : public Object {
 public:
  size_t Size() const;
  void Clear();
  V8_WARN_UNUSED_RESULT MaybeLocal<Set> Add(Local<Context> context,
                                            Local<Value> key);
  V8_WARN_UNUSED_RESULT Maybe<bool> Has(Local<Context> context,
                                        Local<Value> key);
  V8_WARN_UNUSED_RESULT Maybe<bool> Delete(Local<Context> context,
                                           Local<Value> key);

  /**
   * Returns an array of the keys in this Set.
   */
  Local<Array> AsArray() const;

  /**
   * Creates a new empty Set.
   */
  static Local<Set> New(Isolate* isolate);

  V8_INLINE static Set* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Set*>(value);
  }

 private:
  Set();
  static void CheckCast(Value* obj);
};

}  // namespace v8

#endif  // INCLUDE_V8_CONTAINER_H_
