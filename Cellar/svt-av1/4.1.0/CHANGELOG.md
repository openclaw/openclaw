# Changelog

## [4.1] - 2026-03-16

Encoder

- Refactor MD, EncDec, and Entropy Coding kernels (!2604)
- Improve Still Image coding efficiency (!2612, !2614)
- Change Wiener Filter level for chroma for presets M3 and below (!2620)
- Optimize Screen Content coding for Still Image (!2630)

Arm

- Refactor Subpixel Variance kernels (!2608)
- Optimize 16b SAD kernel (!2610)
- Fixed Neoverse V2 unit test detection (!2622)
- Update Arm build guide (!2625)

Bug fixes and documentation

- Fixed a hang caused by improper variable looping (#2338, !2600)
- Add missing option 2 for `--enable-dlf`'s help output (!2601)
- Depth Refinement algorithmic bug fix (!2602)
- Add mutexes to fix hangs when running multiple instances of the encoder in one process (!2603, !2605, !2619)
- Fix motion calculation for cyclic QP refresh (!2613)
- Fixed a Debug vs Release mismatch (!2618)
- Fixed some new warnings with newer GCC versions (!2621)
- Changed Temporal Filtering distortion calculation to not include padding (!2623)
- Cleanup some dead unit tests (!2626)
- Benchmark framework improvements (!2627)
- CI/CD improvements (!2628)
- Fixed some niche crashes (!2629)
- General code and doc cleanup (!2606, !2607, !2609, !2611, !2616, !2617, !2624, !2631)

## [4.0.1] - 2026-01-27

Bug fixes and documentation

- Fixed a missing version bump for shared library and pkg-config (!2593)
  - This is now tied to the CMake project version and should not happen again.
  - Added a CI check to verify this going forward (!2594)
- Fixed tf-strength's default value in the help output (!2595)
- Cleaned up some old debug prints and fixed some Windows build warnings (!2596)
- Fixed bug in incorrect plane selection in quantize_inv_quantize (!2597)
- Fixed hang caused by incorrect update of looping variable in pic_manager_process (!2600)

## [4.0.0] - 2026-01-13

API updates

- Added support for setting a custom global logger for library consumers (!2570, !2579)
- Cleaned up public API headers including removal of deprecated macros, structs, and fields (!2565, !2568)
  - Additionally cleaned up anything marked using `SVT_AV1_CHECK_VERSION()`.
- Added ability to calculate per-frame PSNR and SSIM metrics (!2521)
- Allow sending more than 1 but less than 4 frames with avif mode (This is not for AVIF image sequence, but for encoding an alpha layer) (!2551, !2560)

Encoder

- Added dynamic delta q res switching (SVT-AV1-PSY, !2484, !2504)
- Added new or ported Arm optimizations for various functions (!2478, !2486, !2479, !2497, !2495, !2516, !2519, !2493, !2529, !2531, !2530, !2540, !2541, !2548, !2555, !2553)
- New s-frame QP and QP-offset options (!2477)
- New s-frame mode for setting s-frames at specific positions in decode order (!2523, !2534)
- Ported over intraBC hash search optimizations from libaom (SVT-AV1-PSY, !2491)
- Added togglable adaptive film grain (SVT-AV1-PSY, !2496)
- Added SIMD optimization for memcpy and memset functions for Neon (!2498)
- Added an Image Quality (IQ) tune (SVT-AV1-PSY, !2489, !2514, !2562, !2561)
- Added an option to allow restricting selection of block transforms (SVT-AV1-PSY, !2507, !2576)
- Reduced runtime memory usage for RTC mode (!2505)
- Added extended quarter-step CRF support (SVT-AV1-PSY, !2503, !2522)
- Added `--scm 3` for better screen content detection (SVT-AV1-PSY, !2494, !2559)
- Added CMake configuration file for finding SVT-AV1 package (!2517, !2537)
- Visually improved the detailed progress mode output (SVT-AV1-PSY, !2511)
- Added AC Bias (SVT-AV1-PSY, !2513, !2574)
- Tune lambda-weights for intra frames with high QPs (!2543)
- Still image algorithmic and performance improvements (!2552, !2567)
- RTC mode optimization and preset tuning for all modes (!2558)

Cleanups, bug fixes, and Documentation

In addition to the cleanups mentioned in the API section,

- Code specific cleanup for slimmer binary sizes (!2476)
- Minor CMake build related fixes (!2501)
- Fixed RTC build with unit tests (!2499)
- Changed tune value from integer to enum for better readability (!2506)
- Fixed an issue with the encoder hanging when given an input with a height of 24 pixels or less (!2518)
- Fixed compilation warnings for GCC 15 with Arm (!2525)
- Fixed a bug that results in encoding an invalid bitstream when using rtc with a high QP value (!2502)
- Added CI coverage for compiling FFmpeg on macOS Arm (!2536)
- Fixed a hang with VBR encoding (#2300, !2535)
- Reject inputs with an FPS less than 1 as unsupported, removed `--fps` argument (#2305, !2542, !2546)
- Fixed a hang when using recon output with low delay mode (#2315, !2544)
- Fixed an encoder crash when using RTC with resolutions not divisible by 16 and presets >= 11 (#2301, !2547)
- Added a python based testing framework for comparing codec performance and quality (!2532, !2550, !2556, !2563, !2564, !2566)
- Addressed a partial amount of cppcheck warnings from the version bundled with Ubuntu 24.04 (!2512)
- Fixed a CMake issue when using build.bat and Ninja on Windows (!2569)
- Fixed some compilation and linking issues with Emscripten (!2571)
- Fixed a hang caused by changes in !2452 (#2318, !2572)
- Fixed bitstream level tier compliance with AV1 specification (#2332, !2577, !2581, !2587)
- Removed in-tree gstreamer pluigin (!2586)
- Unit test bug fixes (!2500, !2527, !2549, !2573, !2575)
- General code cleanup and bugfixes (!2524, !2510, !2520, !2528, !2538, !2557, !2582, !2584)
- General documentation and console output changes (!2515, !2508, !2533, !2545, !2554, #2583)

Arm Improvements

For this changelog, the merge requests are only listed here if they included performance impacts in their descriptions. Please refer to the specific MR for more details.

- [Add Neon impl. of apply_zz_based_temporal_filter_planewise_medium functions](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2478)
- [Optimize svt_aom_quantize_b_neon function](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2486)
- [[AArch64] Add SVE implementation of svt_aom_get_final_filtered_pixels](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2479)
- [Optimize the Neon implementation of svt_enc_msb_un_pack2d](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2497)
- [Optimize svt_search_one_dual_neon function](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2495)
- [[AArch64] Optimize svt_compute_cul_level](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2516)
- [Optimize the Neon implementation of dr_prediction_z1/z2](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2519)
- [[aarch64] Replace redundant loads with load+vext in SAD kernels](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2493)
- [[AArch64] Optimize svt_aom_convolve8\*](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2531)
- [Add Neon I8MM implementation svt_av1_filter_intra_predictor](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2530)
- [Optimize Armv8.0 Neon impl of filter_intra_predictor_neon](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2555)
- [Optimize Neon (Armv8.0), Neon I8MM, SVE implementations of av1_warp_affine](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2553)

## [3.1.2] - 2025-8-24

Fix missing version bump

## [3.1.1] - 2025-8-22

Bug Fixes

- Fixed range checks and error message for min-qp and max-qp (!2469, !2470)
- Fixed 10bit lossless encoding (!2470)
- Fixed value range in unit tests (!2473)
- Fixed --tune ssim (#2293, !2480)
- Fixed an overflow bug within a neon function (!2487)

## [3.1.0] - 2025-7-24

API updates

- Added new flags for --chroma-qm-min and --chroma-qm-max from SVT-AV1-PSY (!2442)
- Introducing --rtc flag to set the default parameters for an improved RTC performance (!2443)
- Enabled M11 and M12 presets for rtc mode for faster speed levels (!2452)

Encoder

- Improved mid and high quality presets quality vs speed tradeoffs for fast-decode 0,1,2 modes in random access (!2443):
- ~15-25% speedup for M1-M5 at the same quality levels for fast-decode 0
- ~15-20% speedup for M3-M7 at the same quality levels for fast-decode 1,2
- 1-1.5% BD-Rate improvement for M0 MR
- Significant improvements in Low Delay mode and enabling presets 0-6 by enabling missing coding features
- Improved performance of the RTC mode with ~5-10% BD-Rate improvements at similar complexity across presets M7-M10 (!2452)
- Further Arm Neon and SVE2 optimizations that improve high bitdepth encoding by an average of ~10% in low resolutions
- Added S-Frame support for random access mode (!2451)
- Additional improvements / porting of features from SVT-AV1-PSY for variance boost (!2431, !2432)

Cleanup Build and bug fixes and documentation

- General testing improvements and fixes (!2406, !2454)
- Deprecated unused avx512{er,pf} as they were never used and also removed with GCC 15 (!2415)
- Visual console display fixes (!2420, !2423)
- Fixed compilation bugs and cleanup with Arm (!2417, #2259, !2427, !2434, !2438, !2439)
- Fixed some formulas in the documentation (!2444)
- Added new options to slim down SVT-AV1 for RTC use cases (!2456, !2457, !2459)
- Fixed some issues with QP handling, vbr stability, and screen content (!2458, #2262, #2272, #2273)
- Fixes issue with resize-mode (!2463, #2282, #2260)
- Removed cpuinfo dependency and instead use cpu detection code from aom (!2426, !2453)

Arm Improvements

- Speed comparison was done against v3.0.2 on AWS Graviton4 instances with Clang 20
- Uplits are geometric means across presets 0-10

Landscape video:

- 1080p: +4%
- 720p: +6%
- 480p: +6%
- 360p: +3%
- 240p: +4%

Portrait video:

- 1080p: +8%
- 720p: +4%
- 480p: +3%
- 360p: +7%
- 240p: +4%

## [3.0.2] - 2025-3-21

Encoder

- More Arm simd improvements (!2401, !2402, !2403, !2405, !2409, !2410)
- Fixed mising initalization of lossless and avif (#2255, !2404)

Documentation

- Add missing `--luminance-qp-bias` documentation (!2407)

## [3.0.1] - 2025-3-10

Encoder cleanup and bug fixes

- Further Arm improvements along with fixing arm vs x86 output mismatches (!2393, !2399, !2400, #2247)
- Fixed memory leak in compute_global_motion (!2395, #2248)
- Fixed integer overflow in subpel search to prevent an assertion (!2396, #2250)
- Clean up some undefined behavior (!2398)
- API change fixes now available in FFmpeg and GStreamer (#2249, #2252)

Known issue

- Hard to reproduce SIGTRAP being raised on macOS m1 with libavif's avifsvttest (#2251)

## [3.0.0] - 2025-2-18

API updates

- Refreshed API cleaning up unused fields, use stdbool type and cleanup redundant parameter in `svt_av1_enc_init_handle`
- Repositioned the presets and removed one preset resulting in a max preset of M10 in the current version
- Added temporal layer and averageQP fields in output picture structure, along with an option to specify a QP offset for the startup gop
- The API changes are not backwards compatible, more details about the changes can be found in issue 2217

Encoder

- Improved mid and high quality presets quality vs speed tradeoffs for fast-decode 2 mode:
- ~15-25% speedup for M3-M10 at the same quality levels - (!2376 and !2343)
- ~1% BD-rate improvement for presets M0-M2 - (!2376 and !2343)
- Repositioned the `fast-decode 1` mode to produce ~10% decoder cycle reduction vs `fast-decode 0` while reducing the BD-rate loss to ~1% (!2376)
- Further Arm Neon and SVE2 optimizations that improve high bitdepth encoding by an average of 10-25% for 480p-1080p resolutions beyond the architecture-agnostic algorithmic improvements since v2.3.0
- Ported several features from SVT-AV1-SPY fork to further improve the perceptual quality of `tune 0` mode
- Added an `avif` mode to reduce resource utilization when encoding still images

Cleanup Build and bug fixes and documentation

- third_party: Removed vendored cpuinfo, will attempt to use one provided by the system. For those without cpuinfo, it will be pulled and compiled into the library, similar to before
- Improved the unit test coverage for Arm Neon and SVE2 code
- Updated documentation

## [2.3.0] - 2024-10-28

API updates

- Preset shift: M12/M13 mapped to M11, M7-M11 shifted one position down. API does not change, all presets from MR-M13 will still be accepted
- svt_av1_enc_get_packet API is now a blocking call for low-delay enforcing a picture in, picture out model
- --fast-decode range changed from 0-1 to 0-2 available on all presets
- Introducing a new definition of --lp being levels of parallelism with a new field in the config structure level_of_parallelism
- logical_processors will be deprecated in the 3.0 release

Encoder

- NEW FAST DECODE MODE - (!2280)
- New fast-decode (2) to allow for an average AV1 software cycle reduction of 25-50% vs fast-decode 0 with a 1-3% BD-Rate loss across the presets
- Improved fast-decode (1) option to increase its AV1 software cycle reduction by ~10% while maintaining the same quality levels
- Improved --lp settings for high resolutions, with CRF gaining a ~4% improvement in speed and VBR gaining ~15% (!2323)
- Further Arm-based optimizations improving the efficiency of previously written Arm-neon implementations by an average of 30%. See below for more information on specific presets
- Address speed regressions for high resolutions first pass encode by tuning the threading parameters, with 1080p showing the biggest gains
- Enabled AVX512 by default in cmake allowing for ~2-4% speedup
- Enabled LTO by default if using a new enough compiler (!2288, !2305)
  - If LTO is a problem or causes one, it can be disabled by adding -DSVT_AV1_LTO=OFF to cmake to force it off.
  - Please report any issues that occur when using it.

Cleanup Build and bug fixes and documentation

- third_party: update safestringlib with applicable upstream changes
- Improved the unit test coverage for Arm-neon code
- Updated documentation

Arm Improvements

- Speed comparison was done against v2.2 on AWS Graviton4 instances with Clang 19.1.1
- `--lp 1` was used for all tests

Standard bitdepth (Bosphorus 1080p):

| Preset                        | Uplift |
| ----------------------------- | ------ |
| 0                             | 1.15x  |
| 1                             | 1.24x  |
| 2                             | 1.29x  |
| 3                             | 1.17x  |
| 4                             | 1.22x  |
| 5                             | 1.31x  |
| 6                             | 1.40x  |
| 7 (against 2.2 preset 8)      | 1.50x  |
| 8 (against 2.2 preset 9)      | 1.61x  |
| 9 (against 2.2 preset 10      | 1.31x  |
| 10 (against 2.2 preset 11 )   | 1.29x  |
| 11 (against 2.2 preset 12/13) | 1.24x  |

High bitdepth (Bosphorus 2160p):

| Preset                        | Uplift |
| ----------------------------- | ------ |
| 0                             | 1.18x  |
| 1                             | 1.19x  |
| 2                             | 1.16x  |
| 3                             | 1.27x  |
| 4                             | 1.33x  |
| 5                             | 1.27x  |
| 6                             | 1.33x  |
| 7 (against 2.2 preset 8)      | 1.35x  |
| 8 (against 2.2 preset 9)      | 1.82x  |
| 9 (against 2.2 preset 10)     | 1.95x  |
| 10 (against 2.2 preset 11)    | 1.40x  |
| 11 (against 2.2 preset 12/13) | 1.35x  |

## [2.2.0] - 2024-08-19

API updates

- No API changes on this release

Encoder

- Improve the tradeoffs for the random access mode across presets:
- Speedup of ~15% across presets M0 - M8 while maintaining similar quality levels (!2253)
- Improve the tradeoffs for the low-delay mode across presets (!2260)
- Increased temporal resolution setting to 6L for 4k resolutions by default
- Added Arm optimizations for functions with c_only equivalent yielding an average speedup of ~13% for 4k10bit

Cleanup Build and bug fixes and documentation

- Profile-guided-optimized helper build overhaul
- Major cleanup and fixing of Neon unit test suite
- Address stylecheck dependence on public repositories

## [2.1.2] - 2024-06-27

Cleanup, bug fixes:

- Fixed profile-guided-optimization build by removing the remaining decoder path

## [2.1.1] - 2024-06-25

Cleanup, bug fixes, and documentation improvements:

- Removed the SVT-AV1 Decoder portion of the project. The last version containing the decoder is SVT-AV1 v2.1.0.
- Updated the folder structure and library build order to reflect the removal of the decoder.
- Renamed all files (except for API files) to remove the "Eb" prefix and changed them to camel_case format.
- Updated the gtest version to v1.12.1.
- Added CI support for Arm-based macOS machines.
- Improved documentation for accuracy and completeness.

## [2.1.0] - 2024-05-17

API updates

- One config parameter added within the padding size. Config param structure size remains unchanged
- Presets 6 and 12 are now pointing to presets 7 and 13 respectively due to the lack of spacing between the presets
- Further preset shuffling is being discussed in #2152

Encoder

- Added variance boost support to improve visual quality for the tune vq mode
- Improve the tradeoffs for the random access mode across presets:
- Speedup of 12-40% presets M0, M3, M5 and M6 while maintaining similar quality levels
- Improved the compression efficiency of presets M11-M13 by 1-2% (!2213)
- Added Arm optimizations for functions with c_only equivalent

Cleanup Build and bug fixes and documentation

- Use nasm as a default assembler and yasm as a fallback
- Fix performance regression for systems with multiple processor groups
- Enable building SvtAv1ApiTests and SvtAv1E2ETests for arm
- Added variance boost documentation
- Added a mailmap file to map duplicate git generated emails to the appropriate author

## [2.0.0] - 2024-03-13

Major API updates

- Changed the API signaling the End Of Stream (EOS) with the last frame vs with an empty frame
- OPT_LD_LATENCY2 making the change above is kept in the code to help devs with integration
- Removed the 3-pass VBR mode which changed the calling mechanism of multi-pass VBR
- Moved to a new versioning scheme where the project major version will be updated everytime API/ABI is changed

Encoder

- Improve the tradeoffs for the random access mode across presets:
- Speedup presets MR by ~100% and improved quality along with tradeoff improvements across the higher quality presets (!2179)
- Improved the compression efficiency of presets M9-M13 by 1-4% (!2179)
- Simplified VBR multi-pass to use 2 passes to allow integration with ffmpeg
- Continued adding Arm optimizations for functions with c_only equivalent
- Replaced the 3-pass VBR with a 2-pass VBR to ease the multi-pass integration with ffmpeg
- Memory savings of 20-35% for LP 8 mode in preset M6 and below and 1-5% in other modes / presets

Cleanup and bug fixes and documentation

- Various cleanups and functional bug fixes
- Update the documentation to reflect the rate control changes

## [1.8.0] - 2023-12-11

Encoder

- Improve the tradeoffs for the random access mode across presets:
- Speedup CRF presets M6 to M0 by 17-53% while maintaining similar quality levels
- Re-adjust CRF presets M7 to M13 for better quality with BD-rate gains ranging from 1-4%
- Improve the quality and speed of the 1-pass VBR mode
- More details on the per preset improvements can be found in MR !2143
- Add API allowing to update bitrate / CRF and Key_frame placement during the encoding session for CBR lowdelay mode and CRF Random Access mode
- Arm Neon SIMD optimizations for most critical kernels allowing for a 4.5-8x fps speedup vs the c implementation

Cleanup and bug fixes and documentation

- Various cleanups and functional bug fixes
- Update the documentation for preset options and individual features

## [1.7.0] - 2023-08-23

Encoder

- Improve the tradeoffs for the random access mode across presets MR-M13:
- Quality improvements across all presets and metrics ranging from 0.3% to 4.5% in BD-rate (!2129)
- Spacing between presets [M1-M6] has been adjusted to account for the tradeoff improvements achieved
- As a user guidance when comparing v1.7 vs v1.6 in a convexhull encoding setup:
- v1.7.0 M2 is now at similar quality levels as v1.6.0 M1 while being ~50% faster
- v1.7.0 M3 is now at similar quality levels as v1.6.0 M2 while being ~50% faster
- v1.7.0 M4 is now at similar quality levels as v1.6.0 M3 while being ~40% faster
- v1.7.0 M5 is now at similar quality levels as v1.6.0 M4 while being ~30% faster
- v1.7.0 M6 is now at similar quality levels as v1.6.0 M5 while being ~25% faster
- Added an experimental tune SSIM mode yielding ~3-4% additional SSIM BD-rate gains (!2109)

Build, cleanup and bug fixes

- Various cleanups and functional bug fixes
- Fix build conflict with libaom

## [1.6.0] - 2023-06-18

Encoder

- Improve the tradeoffs for the random access mode across presets M1-M13:
- Speeding up the higher quality presets by 30-40%
- Improving the BD-rate by 1-2% for the faster presets
- Improve the tradeoffs for the low delay mode for both scrren content and non-screen content encoding modes
- Add a toggle to remove the legacy one-frame buffer at the input of the pipeline alowing the low delay mode to operate at sub-frame processing latencies
- Add a new API allowing the user to specify quantization offsets for a region of interest per frame

Build, cleanup and bug fixes

- Various cleanups and functional bug fixes
- Fix the startup minigop size BD-rate loss
- Add ability to run the ci-testing offline

## [1.5.0] - 2023-04-25

Encoder

- Optimize the tradeoffs for M0-M13 speeding up M5-M1 by 15-30% and improving the BDR of M6-M13 by 1-3%
- Create a new preset MR (--preset -1) to be the quality reference
- Optimize the tradeoffs for M8-M13 in the low delay encoding mode (!2052 !2096 and !2102) for SC and non-SC modes
- Add dynamic minigop support for the random access configuration enabled by default in M9 and below
- Add support to allow users to specify lambda scaling factors through the commandline
- Rewrite the gstreamer plugin and updating it to be uptodate with the latest API changes
- Add skip frames feature allowing the user to start encoding after n frames in the file
- Add ability to specify a smaller startup minigop size for every gop to enable faster prefetching
- Fix segmentation support and re-enable it with --aq-mode 1 to allow work on the region of interest API
- Add padding bytes to the EbSvtAv1EncConfiguration configuration structure keep its size unchanged until v2.0

Build, Cleanup and Documentation

- Major cleanups for unused variables, static functions, and comments formatting
- Reduce the size of variables
- Refine app level parsing and reference scaling API calls in the application
- Add dynamic minigop documentation along with updating the documentation accordingly

## [1.4.1] - 2022-12-12

Bugfixes:

- Fix CRF with maxrate bug causing bitrate to be significantly limited for CRF encodings
- Fix command line parsing forcing 1-pass in a 2-pass encoding mode when the --keyint=`x`s format is used
- Fix decoder segfault due to assuming aligned buffers in the inverse transform assembly

## [1.4.0] - 2022-11-30

Encoder

- Adopted the 6L / 32-picture mini-GOP configuraion as default and adjusted MD feature levels accordingly yielding higher compression efficiency gains
- Update the TPL model to account for the larger mini-gop size
- Re-tune presets M0-M12 using the gained coding efficiency for improved quality vs cycles tradeoffs
- Allow duplicate commandline parameters to be parsed and take into consideration the latter to allow AWCY integration

Build, Cleanup and Documentation

- Make include and lib paths friendly to abs and rel paths
- Update preset and API documentation
- Various functional bug fixes
- Remove manual prediction structure support

## [1.3.0] - 2022-10-18

Encoder

- Port SIMD optimizations from libDav1D making the conformant path (Inv. Transform) faster
- Enabling smaller mini-GOP size configurations and tuning it for the low delay mode
- Tuning the low-latency mode in random access targeting latencies from 250ms to 1s
- Adding GOP-constrained Rate Control targeting low-latency streaming applications
- Optimize mode decision features levels for depth partitioning, RDOQ, MD stage0 pruning in-loop filtering temporal filtering and TPL adding more granularity and gaining further quality
- Preset tuning M0-M13 to smooth the spacing and utilize the quality improvements towards better tradeoffs

Build, Cleanup and Documentation

- Update preset and API documentation
- Various functional bug fixes
- Remove the use of GLOB in cmake and use file names

## [1.2.1] - 2022-08-15

- Fix a crash at the end of the encode that may occur when an invalid metadata packet is sent with the EOS packet

Build, Cleanup

- y4m header pasring code cleanup
- API cleanup and enhancements adding string options for RC mode
- Added option to build without app / dec / enc using the build.sh / build.bat scripts

## [1.2.0] - 2022-08-02

Encoder

- Improve CRF preset tradeoffs for both the default and fast-decode modes
- Improve the SSIM-based tradeoffs of the presets without impacting those of PSNR / VMAF
- Improve CBR mode by enhancing the bit-distribution within the gop
- Added support for reference frame scaling
- Added support for quantization matrices
- Added svtparams patches applicable to ffmpeg 4.4
- AVX2 optimizations for low-delay mode
- TPL-based VBR mode improvements
- Improved Chroma RDOQ
- Improve TPL QP Scaling
- Add length info to ivf header
- Fix support for metadata pass-through
- Add ability to specify Chroma and Luma qindex offsets independently on top of CRF qp assignments

Build, Cleanup and Documentation

- Fix multiple API documentation mismatches
- Updated features documentation
- Various functional bug fixes

## [1.1.0] - 2022-05-17

Encoder

- TPL tradeoff optimizations for 4L pred structure
- Quality-vs-cycles tradeoff improvements across all presets
- Add ability to force key_frame positions through ffmpeg for CRF mode
- Minimize the quality impact of fast-decode while maintaining the decoder speedup
- AVX2 optimizations for low delay mode
- Fix VQ issues #1896 #1857 and #1819

Build, Cleanup and Documentation

- API / ABI cleanup and implement independent versioning
- Add UEB_DLL for static linking with pkgconf
- Update system requirements docs
- Rate control code refactoring
- Fix AVX512 vs AVX2 mismatch

## [1.0.0] - 2022-04-22

Encoder

- Added S-frames support
- CBR Rate control mode for low delay
- Added support for chroma position signalling
- Added support for skipping denoising pictures after film grain synthesis
- Extend fast-decode support to cover presets M0-M10
- Simplified --fast-decode to have only one level
- Optimized --fast-decode level 1 for better tradeoffs
- Visual quality improvements addressing issues #1819 / #1297
- Visual quality fixes and improvements for both tune 0 and 1
- Quality vs density tradeoffs tuning across all presets in CRF mode with TPL improvements
- Update default settings to use a longer gop / higher quality preset and lower CRF value
- Various code cleanups and memory optimizations
- Additional AVX2 optimizations
- Fixed all known functional bugs
- More robust rate control parameter verification

Build and Documentation

- Major documentation update and re-structure
- Added more user guides, preset guides and common questions section
- Improve CI coverage
- Reduced unnecessary warnings
- Improved the documentation of the configuration parameters
- Improve Unit Test Coverage
- Address C vs asm mismatches

## [0.9.1] - 2022-02-23

Encoder

- New `key=val` API for setting encoder options along with `--svtav1-params` appside
- New `--fast-decode` option for producing bitstreams tuned for faster decoding M5- M10
- New `--tune` support for a subjectively optimized encoding mode
- Quality vs density tradeoffs improvements for 4k resolutions and reduction or resolution checks
- New SSE kernels for better encoding speed on older hardware
- Bugfix: Removed `DISABLE_REALTIME` and instead implemented better checks for realtime encoding
- All open library bugs resolved and closed

Build and Testing

- Windows: Moved .dll files to the binary directory next to the exe to fix dll loading issues
- Windows: General VS 2017 compilation speedup
- Windows: Added VS 2022
- BSD: Fixed compilation issues and errors surounding GLIBC specific interfaces and conflicting names
- Dockerfile added

## [0.9] - 2022-01-19

Encoder

- New faster presets M9-M12, M12 reaching similar complexity level to that of x264 veryfast
- New multi-pass and single pass VBR implementation minimizing the quality difference vs CRF while reducing the cycle overhead
- Quality vs density tradeoffs improvements across all presets in CRF mode
- Added support for CRF with capped bitrate
- Added support for overlay frames and super resolution
- Fixed film grain synthesis bugs
- Added experimental support for > 4k resolutions
- Added experimental support for the low delay prediction structure
- Significant memory reduction especially for faster presets in a multi-threaded environment
- API configuration structure cleanup removing all invalid or out of date parameters
- Speedup legacy CPUs for faster development by adding SSE code for corresponding C-kernels
- Updated the code license from BSD 2-clause to BSD 3-clause clear
- Cleaned up the code for various kernels
- Updated the user guide and feature documentation

Build and Testing

- Bug fixes
- Improve CI coverage
- Improve Unit Test Coverage
- Address C vs asm mismatches
- Fix static analysis warnings / errors

## [0.8.7] - 2021-05-08

Encoder

- Feature optimizations: creating new mode decision / encode-decode feature levels allowing better speed / quality trade-off granularity
- Preset repositioning after adopting new levels
- Preset 8 achieving similar speed levels as x265 medium tuned for VOD operating mode
- New 1-pass and 2-pass VBR implementation ported from libaom and adapted to the SVT architecture - still a WIP
- Cleaned up old VBR and CVBR RC code along with the lookahead mechanism associated with them
- 2-pass encoding is only available for VBR mode and 1-pass with lookahead is used for CRF
- Improvements for TPL algorithm to handle long clips and easy content
- Memory optimizations, cleaning up data structures to reduce memory usage up to 2x memory reduction in multi-threaded VBR environment
- Additional AVX2 and AVX512 optimizations
- Cleaned up unused command line parameters and left the config params that are linked to ffmpeg / gst
- Update documentation accordingly
- Added HDR support and color primaries signalling (off by default until integrated with ffmpeg)

Build and Testing

- Bug fixes
- Improve CI coverage
- Improve Unit Test Coverage
- Address C vs asm mismatches
- Fix static analysis warnings / errors

## [0.8.6] - 2020-11-28

Encoder

- Further quality-speed tradeoffs tuning for VOD use cases
- Improved TPL support within 1-pass and 2-pass CRF moode
- Continued non-optimized support for 2pass VBR and CRF
- Align kernel nomenclature to prefix svt_aom for kernels brough from libaom to avoid symbol conflicts

Build and Testing

- Bug fixes
- Improve CI
- Added CI support for gitlab
- Improve Unit Test Coverage
- Address C vs asm mismatches
- Fix static analysis warnings / errors
- Add address sanitizer
- Fix symbol conflicts with libaom and libvpx when staticly linked to ffmpeg

## [0.8.5] - 2020-09-04

Relicensing notice

- Change the outbound license from BSD+Patent to the AOM license / patent

Encoder

- Added tpl support to adaptively change lambda and quantization parameters within the frame
- Added multi staged hme support
- Quality speed trade-offs tuned to VOD use cases
- Added first level non-optimized support for 2pass VBR and CRF
- Added combined cli two pass support with options for stats being written to a memory buffer and a specified file
- Added non square partitioning optimizations
- Improved lambda generation

Build and Testing

- Bug fixes
- Improve CI
- Improve Unit Test Coverage
- Address C vs asm mismatches
- Fix static analysis warnings / errors
- Add address sanitizer
- Fix symbol conflicts with libaom and libvpx when staticly linked to ffmpeg

## [0.8.4] - 2020-06-26

Build and Testing

- Bug fixes
- Improve CI
- Improve Unit Test Coverage
- Address C vs asm mismatches
- Fix static analysis warnings / errors
- Add address sanitizer
- Various ffmpeg patch fixes

## [0.8.3] - 2020-04-24

Encoder

- Presets optimization

Build and Testing

- Bug fixes
- Xcode build support

## [0.8.2] - 2020-04-18

Encoder

- Initial Super resolution support
- Mode decision rate estimation enhancements
- Altref improvements
- Manual prediction structure support
- Enhanced RDOQ support
- Improved warp motion
- Improved documentation and help menu
- New command line parameters
- Fix non-multiple of 8 resolution video corruption for 8bit
- Improved multi-stage mode decision support
- Added multi-stage motion estimation support
- Chroma mode decision optimizations
- Added 16bit pipeline support
- Added Mode decision non-square partition weights
- Enhanced qp-scaling assignment
- Memory optimizations
- Added AVX512 Optimizations
- Added AVX2 Optimizations

Decoder

- Improved multi-threading support
- Memory optimizations
- Updated documentation
- Loop filter flow optimization

Encoder and Decoder

- Encoder-Decoder-Common folder structure improvements

Build and Testing

- Bug fixes
- Improve CI
- Improve Unit Test Coverage
- Address C vs asm mismatches
- Support C only builds (for platforms other than x86)

## [0.8.1] - 2020-01-28

Encoder

- Palette support for 10-bit
- Added the first batch of detailed documentation to help developers

Encoder and Decoder

- Code cleanup and refactoring

Build and Testing

- Bug fixes
- Improve CI
- Improve Unit Test Coverage
- Address C vs asm mismatches

## [0.8.0] - 2019-12-20

Encoder

- Preset Optimizations
- Single-core execution memory optimization [-lp 1 -lad 0]
- Rate estimation update enhancements
- Added on / off flags for feature run-time switching
- Added auto-max partitioning algorithm
- Multi-pass partitioning depth support
- Remove deprecated RC mode 1 and shifter RC mode 2 and mode 3 to mode 1 and mode 2 respectively
- Update Cost Calculation for CDEF Filtering
- Intra-Inter Compound for 10-bit
- Eigth-pel optimization
- Added AVX512 Optimizations
- Added AVX2 Optimizations

Decoder

- Initial multi-threading support
- Decoder optimizations / cleanup

Build and Testing

- Bug fixes
- Improve CI
- Improve Unit Test Coverage
- Address C vs asm mismatches

## [0.7.5] - 2019-11-24

Encoder

- RDOQ for 10-bit
- Inter Intra Class pruning at MD-Staging
- Global Motion Vector support for 8-bit and 10-bit
- Interpolation Filter Search support for 10-bit
- Palette Prediction support
- 2-pass encoding support
- ATB 10-bit support at the encode pass
- Simplified MD Staging [only 3 stages]
- Inter-Inter and Inter-Intra Compound for 10-bit
- Intra Paeth for 10-bit
- Filter Intra Prediction
- New-Near and Near-New support
- OBMC Support for 8-bit and 10-bit
- RDOQ Chroma
- ATB Support for Inter Blocks
- Temporal Filtering for 10-bit
- Eight-pel support in predictive ME
- MCTS Tiles support
- Added AVX512 Optimizations
- Added AVX2 Optimizations

Decoder

- SuperRes support
- Reference Frame Scaling support
- 12-bit support
- Annex B support

Build and Testing

- Bug fixes
- Improve CI
- Improve Unit Test Coverage
- Address C vs asm mismatches

## [0.7.0] - 2019-09-26

Encoder

- Enhanced MRP Reference Frames
- Intra Inter Compound
- QP Modulation support
- MFMV Support
- MD Staging design [Up to 4 MD stages and 3 prediction classes: Intra / Inter / Compound]
- Compound Motion prediction
- 10-bit Mode Decision support for Intra
- Thread safe resource allocation
- Added AVX512 Optimizations
- Added AVX2 Optimizations

Decoder

- Screen Content Tools
- Temporal MV scan support
- Inter support
- Screen Content Tools support
- Post Processing Filters support
- Compound Mode (InterInter & InterIntra) Tool support
- Decoder Film Grain support

Build and Testing

- Improve CI
- Improve build scripts
- Improve cmake lists
- Improve Unit Test Coverage
- API update
- Bug fixes

## [0.6.0] - 2019-06-28

- Inital decoder implementation
- Static library support
- Alt-ref pictures - temporal filtering
- Adaptive Transform Block for INTRA
- Adaptive QP scaling
- Decoder - Support for Tiles and 10bit
- API - add option to calculate / report PSNR values
- Support for segmentation
- SIMD Optimizations
- Downsampling 2x2 filtering
- Handle incomplete SBs
- MACROS / trailing / tabs-spaces cleanup

## [0.5.0] - 2019-05-17

- 8 bit / 10 bit 4:2:0 up to 4k60p resolutions
- Presets 0-8
- New API, FFmpeg, GStreamer plugins
- Rate control support (VBR, CVBR)
- Block sizes from 4x4 to 128x128
- Non-square blocks
- Tiles
- Deblocking / CDEF / Restoration filters
- Film Grain
- Warped motion estimation
- Intra block copy
- Trellis quantized coefficient optimization
- Support for 4 and 5 layers prediction structures
- Chroma search in MD
- Multi-reference picture support
