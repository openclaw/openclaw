// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_WEAK_CALLBACK_INFO_H_
#define INCLUDE_V8_WEAK_CALLBACK_INFO_H_

#include "v8config.h"  // NOLINT(build/include_directory)

namespace v8 {

class Isolate;

namespace api_internal {
V8_EXPORT void InternalFieldOutOfBounds(int index);
}  // namespace api_internal

static const int kInternalFieldsInWeakCallback = 2;
static const int kEmbedderFieldsInWeakCallback = 2;

template <typename T>
class WeakCallbackInfo {
 public:
  using Callback = void (*)(const WeakCallbackInfo<T>& data);

  WeakCallbackInfo(Isolate* isolate, T* parameter,
                   void* embedder_fields[kEmbedderFieldsInWeakCallback],
                   Callback* callback)
      : isolate_(isolate), parameter_(parameter), callback_(callback) {
    for (int i = 0; i < kEmbedderFieldsInWeakCallback; ++i) {
      embedder_fields_[i] = embedder_fields[i];
    }
  }

  V8_INLINE Isolate* GetIsolate() const { return isolate_; }
  V8_INLINE T* GetParameter() const { return parameter_; }
  V8_INLINE void* GetInternalField(int index) const;

  // When first called, the embedder MUST Reset() the Global which triggered the
  // callback. The Global itself is unusable for anything else. No v8 other api
  // calls may be called in the first callback. Should additional work be
  // required, the embedder must set a second pass callback, which will be
  // called after all the initial callbacks are processed.
  // Calling SetSecondPassCallback on the second pass will immediately crash.
  void SetSecondPassCallback(Callback callback) const { *callback_ = callback; }

 private:
  Isolate* isolate_;
  T* parameter_;
  Callback* callback_;
  void* embedder_fields_[kEmbedderFieldsInWeakCallback];
};

/**
 * Weakness type for weak handles.
 */
enum class WeakCallbackType {
  /**
   * Passes a user-defined void* parameter back to the callback.
   */
  kParameter,
  /**
   * Passes the first two internal fields of the object back to the callback.
   */
  kInternalFields,
};

template <class T>
void* WeakCallbackInfo<T>::GetInternalField(int index) const {
#ifdef V8_ENABLE_CHECKS
  if (index < 0 || index >= kEmbedderFieldsInWeakCallback) {
    api_internal::InternalFieldOutOfBounds(index);
  }
#endif
  return embedder_fields_[index];
}

}  // namespace v8

#endif  // INCLUDE_V8_WEAK_CALLBACK_INFO_H_
