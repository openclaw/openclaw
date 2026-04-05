# Scalable Video Technology for AV1 (SVT-AV1 Encoder)

The Scalable Video Technology for AV1 (SVT-AV1 Encoder) is an
AV1-compliant software encoder library. The work on the SVT-AV1 encoder
targets the development of a production-quality AV1-encoder with performance
levels applicable to a wide range of applications, from premium VOD to
real-time and live encoding/transcoding.

The SVT-AV1 project was initially founded by Intel in partnership with Netflix,
and was then [adopted](https://aomedia.org/press%20releases/aomedia-software-implementation-working-group-to-bring-av1-to-more-video-platforms/)
by the Alliance of Open Media (AOM) Software Implementation Working Group
(SIWG), in August 2020, to carry on the group's mission.

The canonical URL for this project is at <https://gitlab.com/AOMediaCodec/SVT-AV1>

## License

Up to v0.8.7, SVT-AV1 is licensed under the BSD-2-clause license and the
Alliance for Open Media Patent License 1.0. See [LICENSE](LICENSE-BSD2.md) and
[PATENTS](PATENTS.md) for details. Starting from v0.9, SVT-AV1 is licensed
under the BSD-3-clause clear license and the Alliance for Open Media Patent
License 1.0. See [LICENSE](LICENSE.md) and [PATENTS](PATENTS.md) for details.

## Documentation

**Guides**

- [System Requirements](Docs/System-Requirements.md)
- [How to run SVT-AV1 within ffmpeg](Docs/Ffmpeg.md)
- [Standalone Encoder Usage](Docs/svt-av1_encoder_user_guide.md)
- [List of All Parameters](Docs/Parameters.md)
- [Build Guide](Docs/Build-Guide.md)
- [ARM Build Guide](Docs/ARM-Build-Guide.md)

**Common Questions/Issues**

- [Why build with LTO?](Docs/CommonQuestions.md#why-build-with-lto)
- [Why build with PGO?](Docs/CommonQuestions.md#why-build-with-pgo)
- [What presets do](Docs/CommonQuestions.md#what-presets-do)
- [Scene change detection](Docs/CommonQuestions.md#scene-change-detection)
- [GOP size selection](Docs/CommonQuestions.md#gop-size-selection)
- [Threading and efficiency](Docs/CommonQuestions.md#threading-and-efficiency)
- [Practical advice about grain synthesis](Docs/CommonQuestions.md#practical-advice-about-grain-synthesis)
- [Improving decoding performance](Docs/CommonQuestions.md#improving-decoding-performance)
- [Tuning for animation](Docs/CommonQuestions.md#tuning-for-animation)
- [8 vs. 10-bit encoding](Docs/CommonQuestions.md#8-or-10-bit-encoding)
- [HDR and SDR video](Docs/CommonQuestions.md#hdr-and-sdr)
- [Options that give the best encoding bang-for-buck](Docs/CommonQuestions.md#options-that-give-the-best-encoding-bang-for-buck)
- [Multi-pass encoding](Docs/CommonQuestions.md#multi-pass-encoding)
- [CBR, VBR, and CRF modes](Docs/CommonQuestions.md#bitrate-control-modes)

**Presentations**

- [Big Apple Video 2019](https://www.youtube.com/watch?v=lXqOaYNo8m0)
- [Video @ Scale 2021](https://atscaleconference.com/videos/highly-efficient-svt-av1-based-solutions-for-vod-applications/?contact-form-id=124119&contact-form-sent=163268&contact-form-hash=d4bb3fd420fae91cd39c11bdb69f970a05a152a9&_wpnonce=bba8096d24#contact-form-124119)
- [ICIP 2024](https://aomedia.org/docs/Software_Implementation_Working_Group_Update_ICIP2024.pdf)

**Papers and Blogs**

- [Netflix Blog 2020](https://netflixtechblog.com/svt-av1-an-open-source-av1-encoder-and-decoder-ad295d9b5ca2)
- [SPIE 2020](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/11510/1151021/The-SVT-AV1-encoder--overview-features-and-speed-quality/10.1117/12.2569270.full)
- [SPIE 2021](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/11842/118420T/Towards-much-better-SVT-AV1-quality-cycles-tradeoffs-for-VOD/10.1117/12.2595598.full)
- [SVT-AV1 - Tech Blog 2022](https://networkbuilders.intel.com/blog/svt-av1-enables-highly-efficient-large-scale-video-on-demand-vod-services)
- [SPIE 2022](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/12226/122260S/Enhancing-SVT-AV1-with-LCEVC-to-improve-quality-cycles-trade/10.1117/12.2633882.full)
- [Adaptive Steaming Common Test Conditions](https://aomedia.org/docs/SIWG-D001o.pdf)
- [ICIP 2023](https://arxiv.org/abs/2307.05208)
- [SPIE 2024](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/13137/131370W/Benchmarking-hardware-and-software-encoder-quality-and-performance/10.1117/12.3031754.full)

**Awards**

- [IBC 2025 Innovation Award - Content Everywhere](https://aomedia.org/blog%20posts/SVT-AV1-Wins-IBC-2025-Innovation-Award-in-Content-Everywhere-Category/)

**Design Documents**

- [Encoder Design](Docs/svt-av1-encoder-design.md)

**Technical Appendices**

- [Adaptive Prediction Structure Appendix](Docs/Appendix-Adaptive-Prediction-Structure.md)
- [Altref and Overlay Pictures Appendix](Docs/Appendix-Alt-Refs.md)
- [CDEF Appendix](Docs/Appendix-CDEF.md)
- [CfL Appendix](Docs/Appendix-CfL.md)
- [Compliant Subpel Interpolation Filter Search Appendix](Docs/Appendix-Compliant-Subpel-Interpolation-Filter-Search.md)
- [Compound Mode Prediction Appendix](Docs/Appendix-Compound-Mode-Prediction.md)
- [Deblocking Loop Filter (LF) Appendix](Docs/Appendix-DLF.md)
- [Film Grain Synthesis](Docs/Appendix-Film-Grain-Synthesis.md)
- [Global Motion Appendix](Docs/Appendix-Global-Motion.md)
- [Intra Block Copy Appendix](Docs/Appendix-Intra-Block-Copy.md)
- [Local Warped Motion appendix](Docs/Appendix-Local-Warped-Motion.md)
- [Mode Decision Appendix](Docs/Appendix-Mode-Decision.md)
- [Motion Estimation Appendix](Docs/Appendix-Open-Loop-Motion-Estimation.md)
- [Overlapped Block Motion Compensation Appendix](Docs/Appendix-Overlapped-Block-Motion-Compensation.md)
- [Palette Prediction Appendix](Docs/Appendix-Palette-Prediction.md)
- [Rate Control Appendix](Docs/Appendix-Rate-Control.md)
- [Recursive Intra Appendix](Docs/Appendix-Recursive-Intra.md)
- [Restoration Filter Appendix](Docs/Appendix-Restoration-Filter.md)
- [SQ Weight Appendix](Docs/Appendix-SQ-Weight.md)
- [Super-resolution Appendix](Docs/Appendix-Super-Resolution.md)
- [Temporal Dependency Model](Docs/Appendix-TPL.md)
- [Transform Search Appendix](Docs/Appendix-TX-Search.md)
- [Reference Scaling Appendix](Docs/Appendix-Reference-Scaling.md)
- [Variance Boost Appendix](Docs/Appendix-Variance-Boost.md)
- [Anti-Aliasing Aware Screen Content Detection Mode Appendix](Docs/Appendix-Antialiasing-Aware-Screen-Content-Detection-Mode.md)

**How Can I Contribute?**

- [SVT-AV1 Contribution Guide](Docs/Contribute.md)
