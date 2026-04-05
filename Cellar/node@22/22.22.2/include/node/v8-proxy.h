
// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_PROXY_H_
#define INCLUDE_V8_PROXY_H_

#include "v8-context.h"       // NOLINT(build/include_directory)
#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-object.h"        // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;

/**
 * An instance of the built-in Proxy constructor (ECMA-262, 6th Edition,
 * 26.2.1).
 */
class V8_EXPORT Proxy : public Object {
 public:
  Local<Value> GetTarget();
  Local<Value> GetHandler();
  bool IsRevoked() const;
  void Revoke();

  /**
   * Creates a new Proxy for the target object.
   */
  static MaybeLocal<Proxy> New(Local<Context> context,
                               Local<Object> local_target,
                               Local<Object> local_handler);

  V8_INLINE static Proxy* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<Proxy*>(value);
  }

 private:
  Proxy();
  static void CheckCast(Value* obj);
};

}  // namespace v8

#endif  // INCLUDE_V8_PROXY_H_
