// Copyright 2015 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef V8_INCLUDE_VERSION_H_  // V8_VERSION_H_ conflicts with src/version.h
#define V8_INCLUDE_VERSION_H_

// These macros define the version number for the current version.
// NOTE these macros are used by some of the tool scripts and the build
// system so their names cannot be changed without changing the scripts.
#define V8_MAJOR_VERSION 12
#define V8_MINOR_VERSION 4
#define V8_BUILD_NUMBER 254
#define V8_PATCH_LEVEL 21

// Use 1 for candidates and 0 otherwise.
// (Boolean macro values are not supported by all preprocessors.)
#define V8_IS_CANDIDATE_VERSION 0

#endif  // V8_INCLUDE_VERSION_H_
