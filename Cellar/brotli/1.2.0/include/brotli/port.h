/* Copyright 2016 Google Inc. All Rights Reserved.

   Distributed under MIT license.
   See file LICENSE for detail or copy at https://opensource.org/licenses/MIT
*/

/* Macros for compiler / platform specific API declarations. */

#ifndef BROTLI_COMMON_PORT_H_
#define BROTLI_COMMON_PORT_H_

/* The following macros were borrowed from https://github.com/nemequ/hedley
 * with permission of original author - Evan Nemerson <evan@nemerson.com> */

/* >>> >>> >>> hedley macros */

#define BROTLI_MAKE_VERSION(major, minor, revision) \
  (((major) * 1000000) + ((minor) * 1000) + (revision))

#if defined(__GNUC__) && defined(__GNUC_PATCHLEVEL__)
#define BROTLI_GNUC_VERSION \
  BROTLI_MAKE_VERSION(__GNUC__, __GNUC_MINOR__, __GNUC_PATCHLEVEL__)
#elif defined(__GNUC__)
#define BROTLI_GNUC_VERSION BROTLI_MAKE_VERSION(__GNUC__, __GNUC_MINOR__, 0)
#endif

#if defined(BROTLI_GNUC_VERSION)
#define BROTLI_GNUC_VERSION_CHECK(major, minor, patch) \
  (BROTLI_GNUC_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_GNUC_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(_MSC_FULL_VER) && (_MSC_FULL_VER >= 140000000)
#define BROTLI_MSVC_VERSION                                \
  BROTLI_MAKE_VERSION((_MSC_FULL_VER / 10000000),          \
                      (_MSC_FULL_VER % 10000000) / 100000, \
                      (_MSC_FULL_VER % 100000) / 100)
#elif defined(_MSC_FULL_VER)
#define BROTLI_MSVC_VERSION                              \
  BROTLI_MAKE_VERSION((_MSC_FULL_VER / 1000000),         \
                      (_MSC_FULL_VER % 1000000) / 10000, \
                      (_MSC_FULL_VER % 10000) / 10)
#elif defined(_MSC_VER)
#define BROTLI_MSVC_VERSION \
  BROTLI_MAKE_VERSION(_MSC_VER / 100, _MSC_VER % 100, 0)
#endif

#if !defined(_MSC_VER)
#define BROTLI_MSVC_VERSION_CHECK(major, minor, patch) (0)
#elif defined(_MSC_VER) && (_MSC_VER >= 1400)
#define BROTLI_MSVC_VERSION_CHECK(major, minor, patch) \
  (_MSC_FULL_VER >= ((major * 10000000) + (minor * 100000) + (patch)))
#elif defined(_MSC_VER) && (_MSC_VER >= 1200)
#define BROTLI_MSVC_VERSION_CHECK(major, minor, patch) \
  (_MSC_FULL_VER >= ((major * 1000000) + (minor * 10000) + (patch)))
#else
#define BROTLI_MSVC_VERSION_CHECK(major, minor, patch) \
  (_MSC_VER >= ((major * 100) + (minor)))
#endif

#if defined(__INTEL_COMPILER) && defined(__INTEL_COMPILER_UPDATE)
#define BROTLI_INTEL_VERSION                   \
  BROTLI_MAKE_VERSION(__INTEL_COMPILER / 100,  \
                      __INTEL_COMPILER % 100,  \
                      __INTEL_COMPILER_UPDATE)
#elif defined(__INTEL_COMPILER)
#define BROTLI_INTEL_VERSION \
  BROTLI_MAKE_VERSION(__INTEL_COMPILER / 100, __INTEL_COMPILER % 100, 0)
#endif

#if defined(BROTLI_INTEL_VERSION)
#define BROTLI_INTEL_VERSION_CHECK(major, minor, patch) \
  (BROTLI_INTEL_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_INTEL_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__PGI) && \
    defined(__PGIC__) && defined(__PGIC_MINOR__) && defined(__PGIC_PATCHLEVEL__)
#define BROTLI_PGI_VERSION \
  BROTLI_MAKE_VERSION(__PGIC__, __PGIC_MINOR__, __PGIC_PATCHLEVEL__)
#endif

#if defined(BROTLI_PGI_VERSION)
#define BROTLI_PGI_VERSION_CHECK(major, minor, patch) \
  (BROTLI_PGI_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_PGI_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__SUNPRO_C) && (__SUNPRO_C > 0x1000)
#define BROTLI_SUNPRO_VERSION                                       \
  BROTLI_MAKE_VERSION(                                              \
    (((__SUNPRO_C >> 16) & 0xf) * 10) + ((__SUNPRO_C >> 12) & 0xf), \
    (((__SUNPRO_C >> 8) & 0xf) * 10) + ((__SUNPRO_C >> 4) & 0xf),   \
    (__SUNPRO_C & 0xf) * 10)
#elif defined(__SUNPRO_C)
#define BROTLI_SUNPRO_VERSION                  \
  BROTLI_MAKE_VERSION((__SUNPRO_C >> 8) & 0xf, \
                      (__SUNPRO_C >> 4) & 0xf, \
                      (__SUNPRO_C) & 0xf)
#elif defined(__SUNPRO_CC) && (__SUNPRO_CC > 0x1000)
#define BROTLI_SUNPRO_VERSION                                         \
  BROTLI_MAKE_VERSION(                                                \
    (((__SUNPRO_CC >> 16) & 0xf) * 10) + ((__SUNPRO_CC >> 12) & 0xf), \
    (((__SUNPRO_CC >> 8) & 0xf) * 10) + ((__SUNPRO_CC >> 4) & 0xf),   \
    (__SUNPRO_CC & 0xf) * 10)
#elif defined(__SUNPRO_CC)
#define BROTLI_SUNPRO_VERSION                   \
  BROTLI_MAKE_VERSION((__SUNPRO_CC >> 8) & 0xf, \
                      (__SUNPRO_CC >> 4) & 0xf, \
                      (__SUNPRO_CC) & 0xf)
#endif

#if defined(BROTLI_SUNPRO_VERSION)
#define BROTLI_SUNPRO_VERSION_CHECK(major, minor, patch) \
  (BROTLI_SUNPRO_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_SUNPRO_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__CC_ARM) && defined(__ARMCOMPILER_VERSION)
#define BROTLI_ARM_VERSION                                       \
  BROTLI_MAKE_VERSION((__ARMCOMPILER_VERSION / 1000000),         \
                      (__ARMCOMPILER_VERSION % 1000000) / 10000, \
                      (__ARMCOMPILER_VERSION % 10000) / 100)
#elif defined(__CC_ARM) && defined(__ARMCC_VERSION)
#define BROTLI_ARM_VERSION                                 \
  BROTLI_MAKE_VERSION((__ARMCC_VERSION / 1000000),         \
                      (__ARMCC_VERSION % 1000000) / 10000, \
                      (__ARMCC_VERSION % 10000) / 100)
#endif

#if defined(BROTLI_ARM_VERSION)
#define BROTLI_ARM_VERSION_CHECK(major, minor, patch) \
  (BROTLI_ARM_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_ARM_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__ibmxl__)
#define BROTLI_IBM_VERSION                    \
  BROTLI_MAKE_VERSION(__ibmxl_version__,      \
                      __ibmxl_release__,      \
                      __ibmxl_modification__)
#elif defined(__xlC__) && defined(__xlC_ver__)
#define BROTLI_IBM_VERSION \
  BROTLI_MAKE_VERSION(__xlC__ >> 8, __xlC__ & 0xff, (__xlC_ver__ >> 8) & 0xff)
#elif defined(__xlC__)
#define BROTLI_IBM_VERSION BROTLI_MAKE_VERSION(__xlC__ >> 8, __xlC__ & 0xff, 0)
#endif

#if defined(BROTLI_IBM_VERSION)
#define BROTLI_IBM_VERSION_CHECK(major, minor, patch) \
  (BROTLI_IBM_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_IBM_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__TI_COMPILER_VERSION__)
#define BROTLI_TI_VERSION                                         \
  BROTLI_MAKE_VERSION((__TI_COMPILER_VERSION__ / 1000000),        \
                      (__TI_COMPILER_VERSION__ % 1000000) / 1000, \
                      (__TI_COMPILER_VERSION__ % 1000))
#endif

#if defined(BROTLI_TI_VERSION)
#define BROTLI_TI_VERSION_CHECK(major, minor, patch) \
  (BROTLI_TI_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_TI_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__IAR_SYSTEMS_ICC__)
#if __VER__ > 1000
#define BROTLI_IAR_VERSION                     \
  BROTLI_MAKE_VERSION((__VER__ / 1000000),     \
                      (__VER__ / 1000) % 1000, \
                      (__VER__ % 1000))
#else
#define BROTLI_IAR_VERSION BROTLI_MAKE_VERSION(VER / 100, __VER__ % 100, 0)
#endif
#endif

#if defined(BROTLI_IAR_VERSION)
#define BROTLI_IAR_VERSION_CHECK(major, minor, patch) \
  (BROTLI_IAR_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_IAR_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__TINYC__)
#define BROTLI_TINYC_VERSION \
  BROTLI_MAKE_VERSION(__TINYC__ / 1000, (__TINYC__ / 100) % 10, __TINYC__ % 100)
#endif

#if defined(BROTLI_TINYC_VERSION)
#define BROTLI_TINYC_VERSION_CHECK(major, minor, patch) \
  (BROTLI_TINYC_VERSION >= BROTLI_MAKE_VERSION(major, minor, patch))
#else
#define BROTLI_TINYC_VERSION_CHECK(major, minor, patch) (0)
#endif

#if defined(__has_attribute)
#define BROTLI_GNUC_HAS_ATTRIBUTE(attribute, major, minor, patch) \
  __has_attribute(attribute)
#else
#define BROTLI_GNUC_HAS_ATTRIBUTE(attribute, major, minor, patch) \
  BROTLI_GNUC_VERSION_CHECK(major, minor, patch)
#endif

#if defined(__has_builtin)
#define BROTLI_GNUC_HAS_BUILTIN(builtin, major, minor, patch) \
  __has_builtin(builtin)
#else
#define BROTLI_GNUC_HAS_BUILTIN(builtin, major, minor, patch) \
  BROTLI_GNUC_VERSION_CHECK(major, minor, patch)
#endif

#if defined(__has_feature)
#define BROTLI_HAS_FEATURE(feature) __has_feature(feature)
#else
#define BROTLI_HAS_FEATURE(feature) (0)
#endif

#if defined(_WIN32) || defined(__CYGWIN__)
#define BROTLI_PUBLIC
#elif BROTLI_GNUC_VERSION_CHECK(3, 3, 0) ||                         \
    BROTLI_TI_VERSION_CHECK(8, 0, 0) ||                             \
    BROTLI_INTEL_VERSION_CHECK(16, 0, 0) ||                         \
    BROTLI_ARM_VERSION_CHECK(4, 1, 0) ||                            \
    BROTLI_IBM_VERSION_CHECK(13, 1, 0) ||                           \
    BROTLI_SUNPRO_VERSION_CHECK(5, 11, 0) ||                        \
    (BROTLI_TI_VERSION_CHECK(7, 3, 0) &&                            \
     defined(__TI_GNU_ATTRIBUTE_SUPPORT__) && defined(__TI_EABI__))
#define BROTLI_PUBLIC __attribute__ ((visibility ("default")))
#else
#define BROTLI_PUBLIC
#endif

#if defined(_WIN32) || defined(__CYGWIN__)
#define BROTLI_INTERNAL
#elif BROTLI_GNUC_VERSION_CHECK(3, 3, 0) ||                         \
    BROTLI_TI_VERSION_CHECK(8, 0, 0) ||                             \
    BROTLI_INTEL_VERSION_CHECK(16, 0, 0) ||                         \
    BROTLI_ARM_VERSION_CHECK(4, 1, 0) ||                            \
    BROTLI_IBM_VERSION_CHECK(13, 1, 0) ||                           \
    BROTLI_SUNPRO_VERSION_CHECK(5, 11, 0) ||                        \
    (BROTLI_TI_VERSION_CHECK(7, 3, 0) &&                            \
     defined(__TI_GNU_ATTRIBUTE_SUPPORT__) && defined(__TI_EABI__))
#define BROTLI_INTERNAL __attribute__ ((visibility ("hidden")))
#else
#define BROTLI_INTERNAL
#endif

#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 199901L) &&   \
    !defined(__STDC_NO_VLA__) && !defined(__cplusplus) &&           \
    !defined(__PGI) && !defined(__PGIC__) && !defined(__TINYC__) && \
    !defined(__clang__)
#define BROTLI_ARRAY_PARAM(name) (name)
#else
#define BROTLI_ARRAY_PARAM(name)
#endif

/* <<< <<< <<< end of hedley macros. */

#if defined(BROTLI_SHARED_COMPILATION)
#if defined(_WIN32)
#if defined(BROTLICOMMON_SHARED_COMPILATION)
#define BROTLI_COMMON_API __declspec(dllexport)
#else  /* !BROTLICOMMON_SHARED_COMPILATION */
#define BROTLI_COMMON_API __declspec(dllimport)
#endif  /* BROTLICOMMON_SHARED_COMPILATION */
#if defined(BROTLIDEC_SHARED_COMPILATION)
#define BROTLI_DEC_API __declspec(dllexport)
#else   /* !BROTLIDEC_SHARED_COMPILATION */
#define BROTLI_DEC_API __declspec(dllimport)
#endif  /* BROTLIDEC_SHARED_COMPILATION */
#if defined(BROTLIENC_SHARED_COMPILATION)
#define BROTLI_ENC_API __declspec(dllexport)
#else  /* !BROTLIENC_SHARED_COMPILATION */
#define BROTLI_ENC_API __declspec(dllimport)
#endif  /* BROTLIENC_SHARED_COMPILATION */
#else  /* !_WIN32 */
#define BROTLI_COMMON_API BROTLI_PUBLIC
#define BROTLI_DEC_API BROTLI_PUBLIC
#define BROTLI_ENC_API BROTLI_PUBLIC
#endif  /* _WIN32 */
#else  /* BROTLI_SHARED_COMPILATION */
#define BROTLI_COMMON_API
#define BROTLI_DEC_API
#define BROTLI_ENC_API
#endif

#if defined(BROTLI_BUILD_ENC_EXTRA_API)
#define BROTLI_ENC_EXTRA_API BROTLI_ENC_API
#else
#define BROTLI_ENC_EXTRA_API BROTLI_INTERNAL
#endif

#endif  /* BROTLI_COMMON_PORT_H_ */
