/*
* Copyright(c) 2025 Meta Platforms, Inc. and affiliates.
*
* This source code is subject to the terms of the BSD 2 Clause License and
* the Alliance for Open Media Patent License 1.0. If the BSD 2 Clause License
* was not distributed with this source code in the LICENSE file, you can
* obtain it at https://www.aomedia.org/license/software-license. If the Alliance for Open
* Media Patent License 1.0 was not distributed with this source code in the
* PATENTS file, you can obtain it at https://www.aomedia.org/license/patent-license.
*/

/*
* This file contains configuration macros that control which parts of code are used
* Macros could be fed via command line, so all macros here must check if they are
* already defined!
* All macros must have the following format:
* - all macros must be prefixed with CONFIG_
*/

#ifndef EbConfigMacros_h
#define EbConfigMacros_h

// clang-format off

#ifndef RTC_BUILD
#define RTC_BUILD 0
#endif

#if RTC_BUILD
#define CONFIG_LOG_QUIET                    1

#define CONFIG_ARM_NEON_IS_GUARANTEED       1
#define CONFIG_X86_AVX2_IS_GUARANTEED       0

#define CONFIG_ENABLE_QUANT_MATRIX          0
#define CONFIG_ENABLE_OBMC                  0
#define CONFIG_ENABLE_FILM_GRAIN            0
#define CONFIG_ENABLE_HIGH_BIT_DEPTH        0
#endif


// When set to 1, EB_CPU_FLAGS_NEON is unconditionally set for all ARCH_AARCH64
// builds, i.e. requiring Neon for library to work. This also allows linker to
// strip code for all C functions which are optimized with Neon SIMD and thus
// reduce final binary size.
// Neon is mandatory in Armv8.0-A (AArch64), which is our minimum Arm target,
// so it is guaranteed for deployment builds, however tests use C functions,
// and hence for development builds this must stay at 0.
#ifndef CONFIG_ARM_NEON_IS_GUARANTEED
#define CONFIG_ARM_NEON_IS_GUARANTEED       0
#endif

// Same for x86 builds and AVX2 as minimum required SIMD level.
// AVX2 was first released in 2013 on Haswell microarchitecture, all x86
// processors since support it.
// You can set it to 1 to reduce binary size if deployment platforms are
// guaranteed to be not older than Haswell.
#ifndef CONFIG_X86_AVX2_IS_GUARANTEED
#define CONFIG_X86_AVX2_IS_GUARANTEED       0
#endif

#ifndef CONFIG_LOG_QUIET
#define CONFIG_LOG_QUIET                    0
#endif

#ifndef CONFIG_ENABLE_QUANT_MATRIX
#define CONFIG_ENABLE_QUANT_MATRIX          1
#endif

#ifndef CONFIG_ENABLE_OBMC
#define CONFIG_ENABLE_OBMC                  1
#endif

#ifndef CONFIG_ENABLE_FILM_GRAIN
#define CONFIG_ENABLE_FILM_GRAIN            1
#endif

#ifndef CONFIG_ENABLE_HIGH_BIT_DEPTH
#define CONFIG_ENABLE_HIGH_BIT_DEPTH        1
#endif

// clang-format on

#endif // EbConfigMacros_h
