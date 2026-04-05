// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_DATA_H_
#define INCLUDE_V8_DATA_H_

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;

/**
 * The superclass of objects that can reside on V8's heap.
 */
class V8_EXPORT Data {
 public:
  /**
   * Returns true if this data is a |v8::Value|.
   */
  bool IsValue() const;

  /**
   * Returns true if this data is a |v8::Module|.
   */
  bool IsModule() const;

  /**
   * Returns tru if this data is a |v8::FixedArray|
   */
  bool IsFixedArray() const;

  /**
   * Returns true if this data is a |v8::Private|.
   */
  bool IsPrivate() const;

  /**
   * Returns true if this data is a |v8::ObjectTemplate|.
   */
  bool IsObjectTemplate() const;

  /**
   * Returns true if this data is a |v8::FunctionTemplate|.
   */
  bool IsFunctionTemplate() const;

  /**
   * Returns true if this data is a |v8::Context|.
   */
  bool IsContext() const;

 private:
  Data() = delete;
};

/**
 * A fixed-sized array with elements of type Data.
 */
class V8_EXPORT FixedArray : public Data {
 public:
  int Length() const;
  Local<Data> Get(Local<Context> context, int i) const;

  V8_INLINE static FixedArray* Cast(Data* data) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(data);
#endif
    return reinterpret_cast<FixedArray*>(data);
  }

 private:
  static void CheckCast(Data* obj);
};

}  // namespace v8

#endif  // INCLUDE_V8_DATA_H_
