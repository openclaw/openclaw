// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_EXTENSION_H_
#define INCLUDE_V8_EXTENSION_H_

#include <memory>

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-primitive.h"     // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class FunctionTemplate;

// --- Extensions ---

/**
 * Ignore
 */
class V8_EXPORT Extension {
 public:
  // Note that the strings passed into this constructor must live as long
  // as the Extension itself.
  Extension(const char* name, const char* source = nullptr, int dep_count = 0,
            const char** deps = nullptr, int source_length = -1);
  virtual ~Extension() { delete source_; }
  virtual Local<FunctionTemplate> GetNativeFunctionTemplate(
      Isolate* isolate, Local<String> name) {
    return Local<FunctionTemplate>();
  }

  const char* name() const { return name_; }
  size_t source_length() const { return source_length_; }
  const String::ExternalOneByteStringResource* source() const {
    return source_;
  }
  int dependency_count() const { return dep_count_; }
  const char** dependencies() const { return deps_; }
  void set_auto_enable(bool value) { auto_enable_ = value; }
  bool auto_enable() { return auto_enable_; }

  // Disallow copying and assigning.
  Extension(const Extension&) = delete;
  void operator=(const Extension&) = delete;

 private:
  const char* name_;
  size_t source_length_;  // expected to initialize before source_
  String::ExternalOneByteStringResource* source_;
  int dep_count_;
  const char** deps_;
  bool auto_enable_;
};

void V8_EXPORT RegisterExtension(std::unique_ptr<Extension>);

}  // namespace v8

#endif  // INCLUDE_V8_EXTENSION_H_
