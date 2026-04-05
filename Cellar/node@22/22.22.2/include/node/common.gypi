{
  'variables': {
    'configuring_node%': 0,
    'asan%': 0,
    'ubsan%': 0,
    'visibility%': 'hidden',          # V8's visibility setting
    'target_arch%': 'ia32',           # set v8's target architecture
    'host_arch%': 'ia32',             # set v8's host architecture
    'want_separate_host_toolset%': 0, # V8 should not build target and host
    'library%': 'static_library',     # allow override to 'shared_library' for DLL/.so builds
    'component%': 'static_library',   # NB. these names match with what V8 expects
    'msvs_multi_core_compile': '0',   # we do enable multicore compiles, but not using the V8 way
    'enable_pgo_generate%': '0',
    'enable_pgo_use%': '0',
    'python%': 'python',

    'node_shared%': 'false',
    'force_dynamic_crt%': 0,
    'node_use_v8_platform%': 'true',
    'node_use_bundled_v8%': 'true',
    'node_module_version%': '',
    'node_with_ltcg%': '',
    'node_shared_openssl%': 'false',

    'node_tag%': '',
    'uv_library%': 'static_library',

    'clang%': 0,
    'error_on_warn%': 'false',
    'suppress_all_error_on_warn%': 'false',
    'control_flow_guard%': 'false',

    'openssl_product': '<(STATIC_LIB_PREFIX)openssl<(STATIC_LIB_SUFFIX)',
    'openssl_no_asm%': 0,

    # Don't use ICU data file (icudtl.dat) from V8, we use our own.
    'icu_use_data_file_flag%': 0,

    # Reset this number to 0 on major V8 upgrades.
    # Increment by one for each non-official patch applied to deps/v8.
    'v8_embedder_string': '-node.39',

    ##### V8 defaults for Node.js #####

    # Turn on SipHash for hash seed generation, addresses HashWick
    'v8_use_siphash': 'true',

    # These are more relevant for V8 internal development.
    # Refs: https://github.com/nodejs/node/issues/23122
    # Refs: https://github.com/nodejs/node/issues/23167
    # Enable compiler warnings when using V8_DEPRECATED apis from V8 code.
    'v8_deprecation_warnings': 0,
    # Enable compiler warnings when using V8_DEPRECATE_SOON apis from V8 code.
    'v8_imminent_deprecation_warnings': 0,

    # Enable disassembler for `--print-code` v8 options
    'v8_enable_disassembler': 1,

    # Sets -dOBJECT_PRINT.
    'v8_enable_object_print%': 1,

    # https://github.com/nodejs/node/pull/22920/files#r222779926
    'v8_enable_handle_zapping': 0,

    # Disable pointer compression. Can be enabled at build time via configure
    # options but default values are required here as this file is also used by
    # node-gyp to build addons.
    'v8_enable_pointer_compression%': 0,
    'v8_enable_31bit_smis_on_64bit_arch%': 0,

    # Disable v8 hugepage by default.
    'v8_enable_hugepage%': 0,

    # This is more of a V8 dev setting
    # https://github.com/nodejs/node/pull/22920/files#r222779926
    'v8_enable_fast_mksnapshot': 0,

    'v8_win64_unwinding_info': 1,

    # Variables controlling external defines exposed in public headers.
    'v8_enable_conservative_stack_scanning%': 0,
    'v8_enable_direct_local%': 0,
    'v8_enable_map_packing%': 0,
    'v8_enable_pointer_compression_shared_cage%': 0,
    'v8_enable_external_code_space%': 0,
    'v8_enable_sandbox%': 0,
    'v8_enable_v8_checks%': 0,
    'v8_enable_zone_compression%': 0,
    'v8_use_perfetto': 0,
    'tsan%': 0,

    ##### end V8 defaults #####

    'conditions': [
      ['OS == "win"', {
        'os_posix': 0,
        'v8_postmortem_support%': 0,
        'obj_dir': '<(PRODUCT_DIR)/obj',
        'v8_base': '<(PRODUCT_DIR)/lib/libv8_snapshot.a',
      }, {
        'os_posix': 1,
        'v8_postmortem_support%': 1,
      }],
      ['GENERATOR == "ninja"', {
        'obj_dir': '<(PRODUCT_DIR)/obj',
        'v8_base': '<(PRODUCT_DIR)/obj/tools/v8_gypfiles/libv8_snapshot.a',
      }, {
        'obj_dir%': '<(PRODUCT_DIR)/obj.target',
        'v8_base': '<(PRODUCT_DIR)/obj.target/tools/v8_gypfiles/libv8_snapshot.a',
      }],
      ['OS=="mac"', {
        'obj_dir%': '<(PRODUCT_DIR)/obj.target',
        'v8_base': '<(PRODUCT_DIR)/libv8_snapshot.a',
      }],
      # V8 pointer compression only supports 64bit architectures.
      ['target_arch in "arm ia32 mips mipsel ppc"', {
        'v8_enable_pointer_compression': 0,
        'v8_enable_pointer_compression_shared_cage': 0,
        'v8_enable_31bit_smis_on_64bit_arch': 0,
        'v8_enable_external_code_space': 0,
        'v8_enable_sandbox': 0
      }],
      ['target_arch in "ppc64 s390x"', {
        'v8_enable_backtrace': 1,
      }],
      ['OS=="linux" or OS=="openharmony"', {
        'node_section_ordering_info%': ''
      }],
      ['OS == "zos"', {
        # use ICU data file on z/OS
        'icu_use_data_file_flag%': 1
      }]
    ],
  },

  'target_defaults': {
    'default_configuration': 'Release',
    'configurations': {
      'Debug': {
        'variables': {
          'v8_enable_handle_zapping': 1,
          'conditions': [
            ['node_shared != "true"', {
              'MSVC_runtimeType': 1,    # MultiThreadedDebug (/MTd)
            }, {
              'MSVC_runtimeType': 3,    # MultiThreadedDebugDLL (/MDd)
            }],
          ],
        },
        'defines': [ 'DEBUG', '_DEBUG' ],
        'cflags': [ '-g', '-O0' ],
        'conditions': [
          ['OS in "aix os400"', {
            'cflags': [ '-gxcoff' ],
            'ldflags': [ '-Wl,-bbigtoc' ],
          }],
          ['OS == "android"', {
            'cflags': [ '-fPIC' ],
            'ldflags': [ '-fPIC' ]
          }],
          ['clang==1', {
            'msbuild_toolset': 'ClangCL',
          }],
        ],
        'msvs_settings': {
          'VCCLCompilerTool': {
            'BasicRuntimeChecks': 3,        # /RTC1
            'MinimalRebuild': 'false',
            'OmitFramePointers': 'false',
            'Optimization': 0,              # /Od, no optimization
            'RuntimeLibrary': '<(MSVC_runtimeType)',
          },
          'VCLinkerTool': {
            'LinkIncremental': 2, # enable incremental linking
          },
        },
        'xcode_settings': {
          'GCC_OPTIMIZATION_LEVEL': '0', # stop gyp from defaulting to -Os
        },
      },
      'Release': {
        'variables': {
          'v8_enable_handle_zapping': 0,
          'pgo_generate': ' -fprofile-generate ',
          'pgo_use': ' -fprofile-use -fprofile-correction ',
          'conditions': [
            ['node_shared != "true"', {
              'MSVC_runtimeType': 0    # MultiThreaded (/MT)
            }, {
              'MSVC_runtimeType': 2   # MultiThreadedDLL (/MD)
            }],
            ['clang==1', {
              'lto': ' -flto ', # Clang
            }, {
              'lto': ' -flto=4 -fuse-linker-plugin -ffat-lto-objects ', # GCC
            }],
          ],
        },
        'cflags': [ '-O3' ],
        'conditions': [
          ['enable_lto=="true"', {
            'cflags': ['<(lto)'],
            'ldflags': ['<(lto)'],
            'xcode_settings': {
              'LLVM_LTO': 'YES',
            },
          }],
          ['OS=="linux" or OS=="openharmony"', {
            'conditions': [
              ['node_section_ordering_info!=""', {
                'cflags': [
                  '-fuse-ld=gold',
                  '-ffunction-sections',
                ],
                'ldflags': [
                  '-fuse-ld=gold',
                  '-Wl,--section-ordering-file=<(node_section_ordering_info)',
                ],
              }],
            ],
          }],
          ['OS=="solaris"', {
            # pull in V8's postmortem metadata
            'ldflags': [ '-Wl,-z,allextract' ]
          }],
          ['OS=="zos"', {
            # increase performance, number from experimentation
            'cflags': [ '-qINLINE=::150:100000' ]
          }],
          ['OS!="mac" and OS!="win" and OS!="zos"', {
            # -fno-omit-frame-pointer is necessary for the --perf_basic_prof
            # flag to work correctly. perf(1) gets confused about JS stack
            # frames otherwise, even with --call-graph dwarf.
            'cflags': [ '-fno-omit-frame-pointer' ],
          }],
          ['OS=="linux" or OS=="openharmony"', {
            'conditions': [
              ['enable_pgo_generate=="true"', {
                'cflags': ['<(pgo_generate)'],
                'ldflags': ['<(pgo_generate)'],
              },],
              ['enable_pgo_use=="true"', {
                'cflags': ['<(pgo_use)'],
                'ldflags': ['<(pgo_use)'],
              },],
            ],
          },],
          ['OS == "android"', {
            'cflags': [ '-fPIC', '-I<(android_ndk_path)/sources/android/cpufeatures' ],
            'ldflags': [ '-fPIC' ]
          }],
          ['clang==1', {
            'msbuild_toolset': 'ClangCL',
          }],
        ],
        'msvs_settings': {
          'VCCLCompilerTool': {
            'conditions': [
              ['target_arch=="arm64"', {
                'FloatingPointModel': 1 # /fp:strict
              }]
            ],
            'EnableFunctionLevelLinking': 'true',
            'EnableIntrinsicFunctions': 'true',
            'FavorSizeOrSpeed': 1,          # /Ot, favor speed over size
            'InlineFunctionExpansion': 2,   # /Ob2, inline anything eligible
            'OmitFramePointers': 'true',
            'Optimization': 3,              # /Ox, full optimization
            'RuntimeLibrary': '<(MSVC_runtimeType)',
            'RuntimeTypeInfo': 'false',
          }
        },
        'xcode_settings': {
          'GCC_OPTIMIZATION_LEVEL': '3', # stop gyp from defaulting to -Os
        },
      }
    },

    # Defines these mostly for node-gyp to pickup.
    'defines': [
      '_GLIBCXX_USE_CXX11_ABI=1',
      # This help forks when building Node.js on a 32-bit arch as
      # libuv is always compiled with _FILE_OFFSET_BITS=64
      '_FILE_OFFSET_BITS=64'
    ],

    # Forcibly disable -Werror.  We support a wide range of compilers, it's
    # simply not feasible to squelch all warnings, never mind that the
    # libraries in deps/ are not under our control.
    'conditions': [
      [ 'error_on_warn=="false"', {
        'cflags!': ['-Werror'],
      }, '(_target_name!="<(node_lib_target_name)" or '
          '_target_name!="<(node_core_target_name)")', {
        'cflags!': ['-Werror'],
      }],
    ],
    'msvs_settings': {
      'VCCLCompilerTool': {
        # TODO(targos): Remove condition and always use LanguageStandard options
        # once node-gyp supports them.
        'conditions': [
          ['clang==1', {
            'LanguageStandard': 'stdcpp20',
            'LanguageStandard_C': 'stdc11',
            'AdditionalOptions': [
              '/Zc:__cplusplus',
              # The following option reduces the "error C1060: compiler is out of heap space"
              '/Zm2000',
            ],
          }, {
            'AdditionalOptions': [
              '/Zc:__cplusplus',
              # The following option enables c++20 on Windows. This is needed for V8 v12.4+
              '-std:c++20',
              # The following option reduces the "error C1060: compiler is out of heap space"
              '/Zm2000',
            ],
          }],
          ['control_flow_guard=="true"', {
            'AdditionalOptions': [
              '/guard:cf',                        # Control Flow Guard
            ],
          }],
        ],
        'BufferSecurityCheck': 'true',
        'DebugInformationFormat': 1,          # /Z7 embed info in .obj files
        'ExceptionHandling': 0,               # /EHsc
        'MultiProcessorCompilation': 'true',
        'StringPooling': 'true',              # pool string literals
        'SuppressStartupBanner': 'true',
        'WarnAsError': 'false',
        'WarningLevel': 3,                    # /W3
      },
      'VCLinkerTool': {
        'target_conditions': [
          ['_type=="executable"', {
            'SubSystem': 1,                   # /SUBSYSTEM:CONSOLE
          }],
        ],
        'conditions': [
          ['target_arch=="ia32"', {
            'TargetMachine' : 1,              # /MACHINE:X86
          }],
          ['target_arch=="x64"', {
            'TargetMachine' : 17,             # /MACHINE:X64
          }],
          ['target_arch=="arm64"', {
            'TargetMachine' : 0,              # NotSet. MACHINE:ARM64 is inferred from the input files.
          }],
          ['control_flow_guard=="true"', {
            'AdditionalOptions': [
              '/guard:cf',                        # Control Flow Guard
            ],
          }],
        ],
        'GenerateDebugInformation': 'true',
        'SuppressStartupBanner': 'true',
      },
    },
    # Disable warnings:
    # - "C4251: class needs to have dll-interface"
    # - "C4275: non-DLL-interface used as base for DLL-interface"
    #   Over 10k of these warnings are generated when compiling node,
    #   originating from v8.h. Most of them are false positives.
    #   See also: https://github.com/nodejs/node/pull/15570
    #   TODO: re-enable when Visual Studio fixes these upstream.
    #
    # - "C4267: conversion from 'size_t' to 'int'"
    #   Many any originate from our dependencies, and their sheer number
    #   drowns out other, more legitimate warnings.
    # - "C4244: conversion from 'type1' to 'type2', possible loss of data"
    #   Ususaly safe. Disable for `dep`, enable for `src`
    'msvs_disabled_warnings': [4351, 4355, 4800, 4251, 4275, 4244, 4267],
    'msvs_cygwin_shell': 0, # prevent actions from trying to use cygwin

    'conditions': [
      [ 'configuring_node', {
        'msvs_configuration_attributes': {
          'OutputDirectory': '<(DEPTH)/out/$(Configuration)/',
          'IntermediateDirectory': '$(OutDir)obj/$(ProjectName)/'
        },
      }],
      [ 'target_arch=="x64"', {
        'msvs_configuration_platform': 'x64',
      }],
      [ 'target_arch=="arm64"', {
        'msvs_configuration_platform': 'arm64',
      }],
      ['asan == 1 and OS != "mac" and OS != "zos"', {
        'cflags+': [
          '-fno-omit-frame-pointer',
          '-fsanitize=address',
          '-fsanitize-address-use-after-scope',
        ],
        'defines': [ 'LEAK_SANITIZER', 'V8_USE_ADDRESS_SANITIZER' ],
        'cflags!': [ '-fomit-frame-pointer' ],
        'ldflags': [ '-fsanitize=address' ],
      }],
      ['asan == 1 and OS == "mac"', {
        'xcode_settings': {
          'OTHER_CFLAGS+': [
            '-fno-omit-frame-pointer',
            '-gline-tables-only',
            '-fsanitize=address',
            '-DLEAK_SANITIZER'
          ],
          'OTHER_CFLAGS!': [
            '-fomit-frame-pointer',
          ],
        },
        'target_conditions': [
          ['_type!="static_library"', {
            'xcode_settings': {'OTHER_LDFLAGS': ['-fsanitize=address']},
          }],
        ],
      }],
      ['ubsan == 1 and OS != "mac" and OS != "zos"', {
        'cflags+': [
          '-fno-omit-frame-pointer',
          '-fsanitize=undefined',
        ],
        'defines': [ 'UNDEFINED_SANITIZER'],
        'cflags!': [ '-fno-omit-frame-pointer' ],
        'ldflags': [ '-fsanitize=undefined' ],
      }],
      ['ubsan == 1 and OS == "mac"', {
        'xcode_settings': {
          'OTHER_CFLAGS+': [
            '-fno-omit-frame-pointer',
            '-fsanitize=undefined',
            '-DUNDEFINED_SANITIZER'
          ],
        },
        'target_conditions': [
          ['_type!="static_library"', {
            'xcode_settings': {'OTHER_LDFLAGS': ['-fsanitize=undefined']},
          }],
        ],
      }],
      # The defines bellow must include all things from the external_v8_defines
      # list in v8/BUILD.gn.
      ['v8_enable_v8_checks == 1', {
        'defines': ['V8_ENABLE_CHECKS'],
      }],
      ['v8_enable_pointer_compression == 1', {
        'defines': ['V8_COMPRESS_POINTERS'],
      }],
      ['v8_enable_pointer_compression_shared_cage == 1', {
        'defines': ['V8_COMPRESS_POINTERS_IN_SHARED_CAGE'],
      }],
      ['v8_enable_pointer_compression == 1 or v8_enable_31bit_smis_on_64bit_arch == 1', {
        'defines': ['V8_31BIT_SMIS_ON_64BIT_ARCH'],
      }],
      ['v8_enable_zone_compression == 1', {
        'defines': ['V8_COMPRESS_ZONES',],
      }],
      ['v8_enable_sandbox == 1', {
        'defines': ['V8_ENABLE_SANDBOX',],
      }],
      ['v8_enable_external_code_space == 1', {
        'defines': ['V8_EXTERNAL_CODE_SPACE',],
      }],
      ['v8_deprecation_warnings == 1', {
        'defines': ['V8_DEPRECATION_WARNINGS',],
      }],
      ['v8_imminent_deprecation_warnings == 1', {
        'defines': ['V8_IMMINENT_DEPRECATION_WARNINGS',],
      }],
      ['v8_use_perfetto == 1', {
        'defines': ['V8_USE_PERFETTO',],
      }],
      ['v8_enable_map_packing == 1', {
        'defines': ['V8_MAP_PACKING',],
      }],
      ['tsan == 1', {
        'defines': ['V8_IS_TSAN',],
      }],
      ['v8_enable_conservative_stack_scanning == 1', {
        'defines': ['V8_ENABLE_CONSERVATIVE_STACK_SCANNING',],
      }],
      ['v8_enable_direct_local == 1', {
        'defines': ['V8_ENABLE_DIRECT_LOCAL',],
      }],
      ['OS == "win"', {
        'defines': [
          'WIN32',
          # we don't really want VC++ warning us about
          # how dangerous C functions are...
          '_CRT_SECURE_NO_DEPRECATE',
          # ... or that C implementations shouldn't use
          # POSIX names
          '_CRT_NONSTDC_NO_DEPRECATE',
          # Make sure the STL doesn't try to use exceptions
          '_HAS_EXCEPTIONS=0',
          'BUILDING_V8_SHARED=1',
          'BUILDING_UV_SHARED=1',
          # Stop <windows.h> from defining macros that conflict with
          # std::min() and std::max().  We don't use <windows.h> (much)
          # but we still inherit it from uv.h.
          'NOMINMAX',
        ],
      }],
      [ 'OS in "linux freebsd openbsd solaris aix os400 openharmony"', {
        'cflags': [ '-pthread' ],
        'ldflags': [ '-pthread' ],
      }],
      [ 'OS in "linux freebsd openbsd solaris android aix os400 cloudabi openharmony"', {
        'cflags': [ '-Wall', '-Wextra', '-Wno-unused-parameter', ],
        'cflags_cc': [
          '-fno-rtti',
          '-fno-exceptions',
          '-fno-strict-aliasing',
          '-std=gnu++17',
        ],
        'defines': [ '__STDC_FORMAT_MACROS' ],
        'ldflags': [ '-rdynamic' ],
        'target_conditions': [
          # The 1990s toolchain on SmartOS can't handle thin archives.
          ['_type=="static_library" and OS=="solaris"', {
            'standalone_static_library': 1,
          }],
          ['OS=="openbsd"', {
            'cflags': [ '-I/usr/local/include' ],
            'ldflags': [ '-Wl,-z,wxneeded' ],
          }],
          ['_toolset=="host"', {
            'conditions': [
              [ 'host_arch=="ia32"', {
                'cflags': [ '-m32' ],
                'ldflags': [ '-m32' ],
              }],
              [ 'host_arch=="x64"', {
                'cflags': [ '-m64' ],
                'ldflags': [ '-m64' ],
              }],
              [ 'host_arch=="ppc" and OS not in "aix os400"', {
                'cflags': [ '-m32' ],
                'ldflags': [ '-m32' ],
              }],
              [ 'host_arch=="ppc64" and OS not in "aix os400"', {
                'conditions': [
                  [ 'clang==0', {
                    'cflags': [ '-mminimal-toc' ],
                  }],
                ],
                'cflags': [ '-m64' ],
                'ldflags': [ '-m64' ],
              }],
              [ 'host_arch=="s390x" and OS=="linux"', {
                'cflags': [ '-m64', '-march=z196' ],
                'ldflags': [ '-m64', '-march=z196' ],
              }],
            ],
          }],
          ['_toolset=="target"', {
            'conditions': [
              [ 'target_arch=="ia32"', {
                'cflags': [ '-m32' ],
                'ldflags': [ '-m32' ],
              }],
              [ 'target_arch=="x64"', {
                'cflags': [ '-m64' ],
                'ldflags': [ '-m64' ],
              }],
              [ 'target_arch=="ppc" and OS not in "aix os400"', {
                'cflags': [ '-m32' ],
                'ldflags': [ '-m32' ],
              }],
              [ 'target_arch=="ppc64" and OS not in "aix os400"', {
                'conditions': [
                  [ 'clang==0', {
                    'cflags': [ '-mminimal-toc' ],
                  }],
                ],
                'cflags': [ '-m64' ],
                'ldflags': [ '-m64' ],
              }],
              [ 'target_arch=="s390x" and OS=="linux"', {
                'cflags': [ '-m64', '-march=z196' ],
                'ldflags': [ '-m64', '-march=z196' ],
              }],
            ],
          }],
        ],
        'conditions': [
          [ 'OS=="solaris"', {
            'cflags': [ '-pthreads' ],
            'ldflags': [ '-pthreads' ],
            'cflags!': [ '-pthread' ],
            'ldflags!': [ '-pthread' ],
          }],
          [ 'node_shared=="true"', {
            'cflags': [ '-fPIC' ],
          }],
        ],
      }],
      [ 'OS in "aix os400"', {
        'variables': {
          # Used to differentiate `AIX` and `OS400`(IBM i).
          'aix_variant_name': '<!(uname -s)',
        },
        'cflags': [ '-maix64', ],
        'ldflags!': [ '-rdynamic', ],
        'ldflags': [
          '-Wl,-bbigtoc',
          '-maix64',
        ],
        'conditions': [
          [ '"<(aix_variant_name)"=="OS400"', {            # a.k.a. `IBM i`
            'ldflags': [
              '-Wl,-blibpath:/QOpenSys/pkgs/lib:/QOpenSys/usr/lib',
              '-Wl,-brtl',
            ],
          }, {                                             # else it's `AIX`
            'variables': {
              'gcc_major': '<!(sh -c "${CXX:-g++} -dumpversion")'
            },
            # Disable the following compiler warning:
            #
            #   warning: visibility attribute not supported in this
            #   configuration; ignored [-Wattributes]
            #
            # This is gcc complaining about __attribute((visibility("default"))
            # in static library builds. Legitimate but harmless and it drowns
            # out more relevant warnings.
            'cflags': [ '-Wno-attributes' ],
            'ldflags': [
              '-Wl,-blibpath:/usr/lib:/lib:/opt/freeware/lib/gcc/powerpc-ibm-aix7.3.0.0/>(gcc_major)/pthread/ppc64:/opt/freeware/lib/gcc/powerpc-ibm-aix7.2.0.0/>(gcc_major)/pthread/ppc64:/opt/freeware/lib/pthread/ppc64',
            ],
          }],
        ],
      }],
      ['OS=="android"', {
        'target_conditions': [
          ['_toolset=="target"', {
            'defines': [ '_GLIBCXX_USE_C99_MATH' ],
            'libraries': [ '-llog' ],
          }],
          ['_toolset=="host"', {
            'cflags': [ '-pthread' ],
            'ldflags': [ '-pthread' ],
          }],
        ],
      }],
      ['OS=="mac"', {
        'defines': ['_DARWIN_USE_64_BIT_INODE=1'],
        'xcode_settings': {
          'ALWAYS_SEARCH_USER_PATHS': 'NO',
          'GCC_CW_ASM_SYNTAX': 'NO',                # No -fasm-blocks
          'GCC_DYNAMIC_NO_PIC': 'NO',               # No -mdynamic-no-pic
                                                    # (Equivalent to -fPIC)
          'GCC_ENABLE_CPP_EXCEPTIONS': 'NO',        # -fno-exceptions
          'GCC_ENABLE_CPP_RTTI': 'NO',              # -fno-rtti
          'GCC_ENABLE_PASCAL_STRINGS': 'NO',        # No -mpascal-strings
          'GCC_STRICT_ALIASING': 'NO',              # -fno-strict-aliasing
          'PREBINDING': 'NO',                       # No -Wl,-prebind
          'MACOSX_DEPLOYMENT_TARGET': '11.0',       # -mmacosx-version-min=11.0
          'USE_HEADERMAP': 'NO',
          'WARNING_CFLAGS': [
            '-Wall',
            '-Wendif-labels',
            '-W',
            '-Wno-unused-parameter',
          ],
        },
        'target_conditions': [
          ['_type!="static_library"', {
            'xcode_settings': {
              'OTHER_LDFLAGS': [
                '-Wl,-search_paths_first'
              ],
            },
          }],
        ],
        'conditions': [
          ['target_arch=="ia32"', {
            'xcode_settings': {'ARCHS': ['i386']},
          }],
          ['target_arch=="x64"', {
            'xcode_settings': {'ARCHS': ['x86_64']},
          }],
          ['target_arch=="arm64"', {
            'xcode_settings': {
              'ARCHS': ['arm64'],
              'OTHER_LDFLAGS!': [
                '-Wl,-no_pie',
              ],
            },
          }],
          ['clang==1', {
            'xcode_settings': {
              'GCC_VERSION': 'com.apple.compilers.llvm.clang.1_0',
              'CLANG_CXX_LANGUAGE_STANDARD': 'gnu++17',  # -std=gnu++17
              'CLANG_CXX_LIBRARY': 'libc++',
            },
          }],
        ],
      }],
      ['OS=="freebsd"', {
        'ldflags': [
          '-Wl,--export-dynamic',
        ],
      }],
      # if node is built as an executable,
      #      the openssl mechanism for keeping itself "dload"-ed to ensure proper
      #      atexit cleanup does not apply
      ['node_shared_openssl!="true" and node_shared!="true"', {
        'defines': [
          # `OPENSSL_NO_PINSHARED` prevents openssl from dload
          #      current node executable,
          #      see https://github.com/nodejs/node/pull/21848
          #      or https://github.com/nodejs/node/issues/27925
          'OPENSSL_NO_PINSHARED'
        ],
      }],
      ['node_shared_openssl!="true"', {
        # `OPENSSL_THREADS` is defined via GYP for openSSL for all architectures.
        'defines': [
          'OPENSSL_THREADS',
        ],
      }],
      ['node_shared_openssl!="true" and openssl_no_asm==1', {
        'defines': [
          'OPENSSL_NO_ASM',
        ],
      }],
      ['OS == "zos"', {
        'defines': [
          '_XOPEN_SOURCE_EXTENDED',
          '_XOPEN_SOURCE=600',
          '_UNIX03_THREADS',
          '_UNIX03_WITHDRAWN',
          '_UNIX03_SOURCE',
          '_OPEN_SYS_SOCK_IPV6',
          '_OPEN_SYS_FILE_EXT=1',
          '_POSIX_SOURCE',
          '_OPEN_SYS',
          '_OPEN_SYS_IF_EXT',
          '_OPEN_SYS_SOCK_IPV6',
          '_OPEN_MSGQ_EXT',
          '_LARGE_TIME_API',
          '_ALL_SOURCE',
          '_AE_BIMODAL=1',
          '__IBMCPP_TR1__',
          'NODE_PLATFORM="os390"',
          'PATH_MAX=1024',
          '_ENHANCED_ASCII_EXT=0xFFFFFFFF',
          '_Export=extern',
          '__static_assert=static_assert',
        ],
        'cflags': [
          '-q64',
          '-Wc,DLL',
          '-Wa,GOFF',
          '-qARCH=10',
          '-qASCII',
          '-qTUNE=12',
          '-qENUM=INT',
          '-qEXPORTALL',
          '-qASM',
        ],
        'cflags_cc': [
          '-qxclang=-std=c++14',
        ],
        'ldflags': [
          '-q64',
        ],
        # for addons due to v8config.h include of "zos-base.h":
        'include_dirs':  ['<(zoslib_include_dir)'],
      }],
    ],
  }
}
