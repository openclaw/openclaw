// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

#ifndef SRC_NODE_VERSION_H_
#define SRC_NODE_VERSION_H_

#define NODE_MAJOR_VERSION 22
#define NODE_MINOR_VERSION 22
#define NODE_PATCH_VERSION 2

#define NODE_VERSION_IS_LTS 1
#define NODE_VERSION_LTS_CODENAME "Jod"

#define NODE_VERSION_IS_RELEASE 1

#ifndef NODE_STRINGIFY
#define NODE_STRINGIFY(n) NODE_STRINGIFY_HELPER(n)
#define NODE_STRINGIFY_HELPER(n) #n
#endif

#ifndef NODE_RELEASE
#define NODE_RELEASE "node"
#endif

#ifndef NODE_TAG
# if NODE_VERSION_IS_RELEASE
#  define NODE_TAG ""
# else
#  define NODE_TAG "-pre"
# endif
#else
// NODE_TAG is passed without quotes when rc.exe is run from msbuild
# define NODE_EXE_VERSION NODE_STRINGIFY(NODE_MAJOR_VERSION) "." \
                          NODE_STRINGIFY(NODE_MINOR_VERSION) "." \
                          NODE_STRINGIFY(NODE_PATCH_VERSION)     \
                          NODE_STRINGIFY(NODE_TAG)
#endif

# define NODE_VERSION_STRING  NODE_STRINGIFY(NODE_MAJOR_VERSION) "." \
                              NODE_STRINGIFY(NODE_MINOR_VERSION) "." \
                              NODE_STRINGIFY(NODE_PATCH_VERSION)     \
                              NODE_TAG
#ifndef NODE_EXE_VERSION
# define NODE_EXE_VERSION NODE_VERSION_STRING
#endif

#define NODE_VERSION "v" NODE_VERSION_STRING


#define NODE_VERSION_AT_LEAST(major, minor, patch) \
  (( (major) < NODE_MAJOR_VERSION) \
  || ((major) == NODE_MAJOR_VERSION && (minor) < NODE_MINOR_VERSION) \
  || ((major) == NODE_MAJOR_VERSION && \
      (minor) == NODE_MINOR_VERSION && (patch) <= NODE_PATCH_VERSION))

/**
 * Node.js will refuse to load modules that weren't compiled against its own
 * module ABI number, exposed as the process.versions.modules property.
 *
 * Node.js will refuse to load modules with a non-matching ABI version. The
 * version number here should be changed whenever an ABI-incompatible API change
 * is made in the C++ side, including in V8 or other dependencies.
 *
 * Node.js will not change the module version during a Major release line
 * We will, at times update the version of V8 shipped in the release line
 * if it can be made ABI compatible with the previous version.
 *
 * Embedders building Node.js can define NODE_EMBEDDER_MODULE_VERSION to
 * override the default value of NODE_MODULE_VERSION.
 *
 * The registry of used NODE_MODULE_VERSION numbers is located at
 *   https://github.com/nodejs/node/blob/HEAD/doc/abi_version_registry.json
 * Extenders, embedders and other consumers of Node.js that require ABI
 * version matching should open a pull request to reserve a number in this
 * registry.
 */
#if defined(NODE_EMBEDDER_MODULE_VERSION)
#define NODE_MODULE_VERSION NODE_EMBEDDER_MODULE_VERSION
#else
#define NODE_MODULE_VERSION 127
#endif

// The NAPI_VERSION supported by the runtime. This is the inclusive range of
// versions which the Node.js binary being built supports.
#define NODE_API_SUPPORTED_VERSION_MAX 10
#define NODE_API_SUPPORTED_VERSION_MIN 1

// Node API modules use NAPI_VERSION 8 by default if it is not explicitly
// specified. It must be always 8.
#define NODE_API_DEFAULT_MODULE_API_VERSION 8

#endif  // SRC_NODE_VERSION_H_
