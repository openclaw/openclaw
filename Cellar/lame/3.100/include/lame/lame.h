/*
 *	Interface to MP3 LAME encoding engine
 *
 *	Copyright (c) 1999 Mark Taylor
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Library General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Library General Public License for more details.
 *
 * You should have received a copy of the GNU Library General Public
 * License along with this library; if not, write to the
 * Free Software Foundation, Inc., 59 Temple Place - Suite 330,
 * Boston, MA 02111-1307, USA.
 */

/* $Id: lame.h,v 1.192 2017/08/31 14:14:46 robert Exp $ */

#ifndef LAME_LAME_H
#define LAME_LAME_H

/* for size_t typedef */
#include <stddef.h>
/* for va_list typedef */
#include <stdarg.h>
/* for FILE typedef, TODO: remove when removing lame_mp3_tags_fid */
#include <stdio.h>

#if defined(__cplusplus)
extern "C" {
#endif

typedef void (*lame_report_function)(const char *format, va_list ap);

#if defined(WIN32) || defined(_WIN32)
#undef CDECL
#define CDECL __cdecl
#else
#define CDECL
#endif

#define DEPRECATED_OR_OBSOLETE_CODE_REMOVED 1

typedef enum vbr_mode_e {
  vbr_off=0,
  vbr_mt,               /* obsolete, same as vbr_mtrh */
  vbr_rh,
  vbr_abr,
  vbr_mtrh,
  vbr_max_indicator,    /* Don't use this! It's used for sanity checks.       */
  vbr_default=vbr_mtrh    /* change this to change the default VBR mode of LAME */
} vbr_mode;


/* MPEG modes */
typedef enum MPEG_mode_e {
  STEREO = 0,
  JOINT_STEREO,
  DUAL_CHANNEL,   /* LAME doesn't supports this! */
  MONO,
  NOT_SET,
  MAX_INDICATOR   /* Don't use this! It's used for sanity checks. */
} MPEG_mode;

/* Padding types */
typedef enum Padding_type_e {
  PAD_NO = 0,
  PAD_ALL,
  PAD_ADJUST,
  PAD_MAX_INDICATOR   /* Don't use this! It's used for sanity checks. */
} Padding_type;



/*presets*/
typedef enum preset_mode_e {
    /*values from 8 to 320 should be reserved for abr bitrates*/
    /*for abr I'd suggest to directly use the targeted bitrate as a value*/
    ABR_8 = 8,
    ABR_320 = 320,

    V9 = 410, /*Vx to match Lame and VBR_xx to match FhG*/
    VBR_10 = 410,
    V8 = 420,
    VBR_20 = 420,
    V7 = 430,
    VBR_30 = 430,
    V6 = 440,
    VBR_40 = 440,
    V5 = 450,
    VBR_50 = 450,
    V4 = 460,
    VBR_60 = 460,
    V3 = 470,
    VBR_70 = 470,
    V2 = 480,
    VBR_80 = 480,
    V1 = 490,
    VBR_90 = 490,
    V0 = 500,
    VBR_100 = 500,



    /*still there for compatibility*/
    R3MIX = 1000,
    STANDARD = 1001,
    EXTREME = 1002,
    INSANE = 1003,
    STANDARD_FAST = 1004,
    EXTREME_FAST = 1005,
    MEDIUM = 1006,
    MEDIUM_FAST = 1007
} preset_mode;


/*asm optimizations*/
typedef enum asm_optimizations_e {
    MMX = 1,
    AMD_3DNOW = 2,
    SSE = 3
} asm_optimizations;


/* psychoacoustic model */
typedef enum Psy_model_e {
    PSY_GPSYCHO = 1,
    PSY_NSPSYTUNE = 2
} Psy_model;


/* buffer considerations */
typedef enum buffer_constraint_e {
    MDB_DEFAULT=0,
    MDB_STRICT_ISO=1,
    MDB_MAXIMUM=2
} buffer_constraint;


struct lame_global_struct;
typedef struct lame_global_struct lame_global_flags;
typedef lame_global_flags *lame_t;




/***********************************************************************
 *
 *  The LAME API
 *  These functions should be called, in this order, for each
 *  MP3 file to be encoded.  See the file "API" for more documentation
 *
 ***********************************************************************/


/*
 * REQUIRED:
 * initialize the encoder.  sets default for all encoder parameters,
 * returns NULL if some malloc()'s failed
 * otherwise returns pointer to structure needed for all future
 * API calls.
 */
lame_global_flags * CDECL lame_init(void);
#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/* obsolete version */
int CDECL lame_init_old(lame_global_flags *);
#endif

/*
 * OPTIONAL:
 * set as needed to override defaults
 */

/********************************************************************
 *  input stream description
 ***********************************************************************/
/* number of samples.  default = 2^32-1   */
int CDECL lame_set_num_samples(lame_global_flags *, unsigned long);
unsigned long CDECL lame_get_num_samples(const lame_global_flags *);

/* input sample rate in Hz.  default = 44100hz */
int CDECL lame_set_in_samplerate(lame_global_flags *, int);
int CDECL lame_get_in_samplerate(const lame_global_flags *);

/* number of channels in input stream. default=2  */
int CDECL lame_set_num_channels(lame_global_flags *, int);
int CDECL lame_get_num_channels(const lame_global_flags *);

/*
  scale the input by this amount before encoding.  default=1
  (not used by decoding routines)
*/
int CDECL lame_set_scale(lame_global_flags *, float);
float CDECL lame_get_scale(const lame_global_flags *);

/*
  scale the channel 0 (left) input by this amount before encoding.  default=1
  (not used by decoding routines)
*/
int CDECL lame_set_scale_left(lame_global_flags *, float);
float CDECL lame_get_scale_left(const lame_global_flags *);

/*
  scale the channel 1 (right) input by this amount before encoding.  default=1
  (not used by decoding routines)
*/
int CDECL lame_set_scale_right(lame_global_flags *, float);
float CDECL lame_get_scale_right(const lame_global_flags *);

/*
  output sample rate in Hz.  default = 0, which means LAME picks best value
  based on the amount of compression.  MPEG only allows:
  MPEG1    32, 44.1,   48khz
  MPEG2    16, 22.05,  24
  MPEG2.5   8, 11.025, 12
  (not used by decoding routines)
*/
int CDECL lame_set_out_samplerate(lame_global_flags *, int);
int CDECL lame_get_out_samplerate(const lame_global_flags *);


/********************************************************************
 *  general control parameters
 ***********************************************************************/
/* 1=cause LAME to collect data for an MP3 frame analyzer. default=0 */
int CDECL lame_set_analysis(lame_global_flags *, int);
int CDECL lame_get_analysis(const lame_global_flags *);

/*
  1 = write a Xing VBR header frame.
  default = 1
  this variable must have been added by a Hungarian notation Windows programmer :-)
*/
int CDECL lame_set_bWriteVbrTag(lame_global_flags *, int);
int CDECL lame_get_bWriteVbrTag(const lame_global_flags *);

/* 1=decode only.  use lame/mpglib to convert mp3/ogg to wav.  default=0 */
int CDECL lame_set_decode_only(lame_global_flags *, int);
int CDECL lame_get_decode_only(const lame_global_flags *);

#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/* 1=encode a Vorbis .ogg file.  default=0 */
/* DEPRECATED */
int CDECL lame_set_ogg(lame_global_flags *, int);
int CDECL lame_get_ogg(const lame_global_flags *);
#endif

/*
  internal algorithm selection.  True quality is determined by the bitrate
  but this variable will effect quality by selecting expensive or cheap algorithms.
  quality=0..9.  0=best (very slow).  9=worst.
  recommended:  2     near-best quality, not too slow
                5     good quality, fast
                7     ok quality, really fast
*/
int CDECL lame_set_quality(lame_global_flags *, int);
int CDECL lame_get_quality(const lame_global_flags *);

/*
  mode = 0,1,2,3 = stereo, jstereo, dual channel (not supported), mono
  default: lame picks based on compression ration and input channels
*/
int CDECL lame_set_mode(lame_global_flags *, MPEG_mode);
MPEG_mode CDECL lame_get_mode(const lame_global_flags *);

#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/*
  mode_automs.  Use a M/S mode with a switching threshold based on
  compression ratio
  DEPRECATED
*/
int CDECL lame_set_mode_automs(lame_global_flags *, int);
int CDECL lame_get_mode_automs(const lame_global_flags *);
#endif

/*
  force_ms.  Force M/S for all frames.  For testing only.
  default = 0 (disabled)
*/
int CDECL lame_set_force_ms(lame_global_flags *, int);
int CDECL lame_get_force_ms(const lame_global_flags *);

/* use free_format?  default = 0 (disabled) */
int CDECL lame_set_free_format(lame_global_flags *, int);
int CDECL lame_get_free_format(const lame_global_flags *);

/* perform ReplayGain analysis?  default = 0 (disabled) */
int CDECL lame_set_findReplayGain(lame_global_flags *, int);
int CDECL lame_get_findReplayGain(const lame_global_flags *);

/* decode on the fly. Search for the peak sample. If the ReplayGain
 * analysis is enabled then perform the analysis on the decoded data
 * stream. default = 0 (disabled)
 * NOTE: if this option is set the build-in decoder should not be used */
int CDECL lame_set_decode_on_the_fly(lame_global_flags *, int);
int CDECL lame_get_decode_on_the_fly(const lame_global_flags *);

#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/* DEPRECATED: now does the same as lame_set_findReplayGain()
   default = 0 (disabled) */
int CDECL lame_set_ReplayGain_input(lame_global_flags *, int);
int CDECL lame_get_ReplayGain_input(const lame_global_flags *);

/* DEPRECATED: now does the same as
   lame_set_decode_on_the_fly() && lame_set_findReplayGain()
   default = 0 (disabled) */
int CDECL lame_set_ReplayGain_decode(lame_global_flags *, int);
int CDECL lame_get_ReplayGain_decode(const lame_global_flags *);

/* DEPRECATED: now does the same as lame_set_decode_on_the_fly()
   default = 0 (disabled) */
int CDECL lame_set_findPeakSample(lame_global_flags *, int);
int CDECL lame_get_findPeakSample(const lame_global_flags *);
#endif

/* counters for gapless encoding */
int CDECL lame_set_nogap_total(lame_global_flags*, int);
int CDECL lame_get_nogap_total(const lame_global_flags*);

int CDECL lame_set_nogap_currentindex(lame_global_flags* , int);
int CDECL lame_get_nogap_currentindex(const lame_global_flags*);


/*
 * OPTIONAL:
 * Set printf like error/debug/message reporting functions.
 * The second argument has to be a pointer to a function which looks like
 *   void my_debugf(const char *format, va_list ap)
 *   {
 *       (void) vfprintf(stdout, format, ap);
 *   }
 * If you use NULL as the value of the pointer in the set function, the
 * lame buildin function will be used (prints to stderr).
 * To quiet any output you have to replace the body of the example function
 * with just "return;" and use it in the set function.
 */
int CDECL lame_set_errorf(lame_global_flags *, lame_report_function);
int CDECL lame_set_debugf(lame_global_flags *, lame_report_function);
int CDECL lame_set_msgf  (lame_global_flags *, lame_report_function);



/* set one of brate compression ratio.  default is compression ratio of 11.  */
int CDECL lame_set_brate(lame_global_flags *, int);
int CDECL lame_get_brate(const lame_global_flags *);
int CDECL lame_set_compression_ratio(lame_global_flags *, float);
float CDECL lame_get_compression_ratio(const lame_global_flags *);


int CDECL lame_set_preset( lame_global_flags*  gfp, int );
int CDECL lame_set_asm_optimizations( lame_global_flags*  gfp, int, int );



/********************************************************************
 *  frame params
 ***********************************************************************/
/* mark as copyright.  default=0 */
int CDECL lame_set_copyright(lame_global_flags *, int);
int CDECL lame_get_copyright(const lame_global_flags *);

/* mark as original.  default=1 */
int CDECL lame_set_original(lame_global_flags *, int);
int CDECL lame_get_original(const lame_global_flags *);

/* error_protection.  Use 2 bytes from each frame for CRC checksum. default=0 */
int CDECL lame_set_error_protection(lame_global_flags *, int);
int CDECL lame_get_error_protection(const lame_global_flags *);

#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/* padding_type. 0=pad no frames  1=pad all frames 2=adjust padding(default) */
int CDECL lame_set_padding_type(lame_global_flags *, Padding_type);
Padding_type CDECL lame_get_padding_type(const lame_global_flags *);
#endif

/* MP3 'private extension' bit  Meaningless.  default=0 */
int CDECL lame_set_extension(lame_global_flags *, int);
int CDECL lame_get_extension(const lame_global_flags *);

/* enforce strict ISO compliance.  default=0 */
int CDECL lame_set_strict_ISO(lame_global_flags *, int);
int CDECL lame_get_strict_ISO(const lame_global_flags *);


/********************************************************************
 * quantization/noise shaping
 ***********************************************************************/

/* disable the bit reservoir. For testing only. default=0 */
int CDECL lame_set_disable_reservoir(lame_global_flags *, int);
int CDECL lame_get_disable_reservoir(const lame_global_flags *);

/* select a different "best quantization" function. default=0  */
int CDECL lame_set_quant_comp(lame_global_flags *, int);
int CDECL lame_get_quant_comp(const lame_global_flags *);
int CDECL lame_set_quant_comp_short(lame_global_flags *, int);
int CDECL lame_get_quant_comp_short(const lame_global_flags *);

int CDECL lame_set_experimentalX(lame_global_flags *, int); /* compatibility*/
int CDECL lame_get_experimentalX(const lame_global_flags *);

/* another experimental option.  for testing only */
int CDECL lame_set_experimentalY(lame_global_flags *, int);
int CDECL lame_get_experimentalY(const lame_global_flags *);

/* another experimental option.  for testing only */
int CDECL lame_set_experimentalZ(lame_global_flags *, int);
int CDECL lame_get_experimentalZ(const lame_global_flags *);

/* Naoki's psycho acoustic model.  default=0 */
int CDECL lame_set_exp_nspsytune(lame_global_flags *, int);
int CDECL lame_get_exp_nspsytune(const lame_global_flags *);

void CDECL lame_set_msfix(lame_global_flags *, double);
float CDECL lame_get_msfix(const lame_global_flags *);


/********************************************************************
 * VBR control
 ***********************************************************************/
/* Types of VBR.  default = vbr_off = CBR */
int CDECL lame_set_VBR(lame_global_flags *, vbr_mode);
vbr_mode CDECL lame_get_VBR(const lame_global_flags *);

/* VBR quality level.  0=highest  9=lowest  */
int CDECL lame_set_VBR_q(lame_global_flags *, int);
int CDECL lame_get_VBR_q(const lame_global_flags *);

/* VBR quality level.  0=highest  9=lowest, Range [0,...,10[  */
int CDECL lame_set_VBR_quality(lame_global_flags *, float);
float CDECL lame_get_VBR_quality(const lame_global_flags *);

/* Ignored except for VBR=vbr_abr (ABR mode) */
int CDECL lame_set_VBR_mean_bitrate_kbps(lame_global_flags *, int);
int CDECL lame_get_VBR_mean_bitrate_kbps(const lame_global_flags *);

int CDECL lame_set_VBR_min_bitrate_kbps(lame_global_flags *, int);
int CDECL lame_get_VBR_min_bitrate_kbps(const lame_global_flags *);

int CDECL lame_set_VBR_max_bitrate_kbps(lame_global_flags *, int);
int CDECL lame_get_VBR_max_bitrate_kbps(const lame_global_flags *);

/*
  1=strictly enforce VBR_min_bitrate.  Normally it will be violated for
  analog silence
*/
int CDECL lame_set_VBR_hard_min(lame_global_flags *, int);
int CDECL lame_get_VBR_hard_min(const lame_global_flags *);

/* for preset */
#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
int CDECL lame_set_preset_expopts(lame_global_flags *, int);
#endif

/********************************************************************
 * Filtering control
 ***********************************************************************/
/* freq in Hz to apply lowpass. Default = 0 = lame chooses.  -1 = disabled */
int CDECL lame_set_lowpassfreq(lame_global_flags *, int);
int CDECL lame_get_lowpassfreq(const lame_global_flags *);
/* width of transition band, in Hz.  Default = one polyphase filter band */
int CDECL lame_set_lowpasswidth(lame_global_flags *, int);
int CDECL lame_get_lowpasswidth(const lame_global_flags *);

/* freq in Hz to apply highpass. Default = 0 = lame chooses.  -1 = disabled */
int CDECL lame_set_highpassfreq(lame_global_flags *, int);
int CDECL lame_get_highpassfreq(const lame_global_flags *);
/* width of transition band, in Hz.  Default = one polyphase filter band */
int CDECL lame_set_highpasswidth(lame_global_flags *, int);
int CDECL lame_get_highpasswidth(const lame_global_flags *);


/********************************************************************
 * psycho acoustics and other arguments which you should not change
 * unless you know what you are doing
 ***********************************************************************/

/* only use ATH for masking */
int CDECL lame_set_ATHonly(lame_global_flags *, int);
int CDECL lame_get_ATHonly(const lame_global_flags *);

/* only use ATH for short blocks */
int CDECL lame_set_ATHshort(lame_global_flags *, int);
int CDECL lame_get_ATHshort(const lame_global_flags *);

/* disable ATH */
int CDECL lame_set_noATH(lame_global_flags *, int);
int CDECL lame_get_noATH(const lame_global_flags *);

/* select ATH formula */
int CDECL lame_set_ATHtype(lame_global_flags *, int);
int CDECL lame_get_ATHtype(const lame_global_flags *);

/* lower ATH by this many db */
int CDECL lame_set_ATHlower(lame_global_flags *, float);
float CDECL lame_get_ATHlower(const lame_global_flags *);

/* select ATH adaptive adjustment type */
int CDECL lame_set_athaa_type( lame_global_flags *, int);
int CDECL lame_get_athaa_type( const lame_global_flags *);

#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/* select the loudness approximation used by the ATH adaptive auto-leveling  */
int CDECL lame_set_athaa_loudapprox( lame_global_flags *, int);
int CDECL lame_get_athaa_loudapprox( const lame_global_flags *);
#endif

/* adjust (in dB) the point below which adaptive ATH level adjustment occurs */
int CDECL lame_set_athaa_sensitivity( lame_global_flags *, float);
float CDECL lame_get_athaa_sensitivity( const lame_global_flags* );

#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/* OBSOLETE: predictability limit (ISO tonality formula) */
int CDECL lame_set_cwlimit(lame_global_flags *, int);
int CDECL lame_get_cwlimit(const lame_global_flags *);
#endif

/*
  allow blocktypes to differ between channels?
  default: 0 for jstereo, 1 for stereo
*/
int CDECL lame_set_allow_diff_short(lame_global_flags *, int);
int CDECL lame_get_allow_diff_short(const lame_global_flags *);

/* use temporal masking effect (default = 1) */
int CDECL lame_set_useTemporal(lame_global_flags *, int);
int CDECL lame_get_useTemporal(const lame_global_flags *);

/* use temporal masking effect (default = 1) */
int CDECL lame_set_interChRatio(lame_global_flags *, float);
float CDECL lame_get_interChRatio(const lame_global_flags *);

/* disable short blocks */
int CDECL lame_set_no_short_blocks(lame_global_flags *, int);
int CDECL lame_get_no_short_blocks(const lame_global_flags *);

/* force short blocks */
int CDECL lame_set_force_short_blocks(lame_global_flags *, int);
int CDECL lame_get_force_short_blocks(const lame_global_flags *);

/* Input PCM is emphased PCM (for instance from one of the rarely
   emphased CDs), it is STRONGLY not recommended to use this, because
   psycho does not take it into account, and last but not least many decoders
   ignore these bits */
int CDECL lame_set_emphasis(lame_global_flags *, int);
int CDECL lame_get_emphasis(const lame_global_flags *);



/************************************************************************/
/* internal variables, cannot be set...                                 */
/* provided because they may be of use to calling application           */
/************************************************************************/
/* version  0=MPEG-2  1=MPEG-1  (2=MPEG-2.5)     */
int CDECL lame_get_version(const lame_global_flags *);

/* encoder delay   */
int CDECL lame_get_encoder_delay(const lame_global_flags *);

/*
  padding appended to the input to make sure decoder can fully decode
  all input.  Note that this value can only be calculated during the
  call to lame_encoder_flush().  Before lame_encoder_flush() has
  been called, the value of encoder_padding = 0.
*/
int CDECL lame_get_encoder_padding(const lame_global_flags *);

/* size of MPEG frame */
int CDECL lame_get_framesize(const lame_global_flags *);

/* number of PCM samples buffered, but not yet encoded to mp3 data. */
int CDECL lame_get_mf_samples_to_encode( const lame_global_flags*  gfp );

/*
  size (bytes) of mp3 data buffered, but not yet encoded.
  this is the number of bytes which would be output by a call to
  lame_encode_flush_nogap.  NOTE: lame_encode_flush() will return
  more bytes than this because it will encode the reamining buffered
  PCM samples before flushing the mp3 buffers.
*/
int CDECL lame_get_size_mp3buffer( const lame_global_flags*  gfp );

/* number of frames encoded so far */
int CDECL lame_get_frameNum(const lame_global_flags *);

/*
  lame's estimate of the total number of frames to be encoded
   only valid if calling program set num_samples
*/
int CDECL lame_get_totalframes(const lame_global_flags *);

/* RadioGain value. Multiplied by 10 and rounded to the nearest. */
int CDECL lame_get_RadioGain(const lame_global_flags *);

/* AudiophileGain value. Multipled by 10 and rounded to the nearest. */
int CDECL lame_get_AudiophileGain(const lame_global_flags *);

/* the peak sample */
float CDECL lame_get_PeakSample(const lame_global_flags *);

/* Gain change required for preventing clipping. The value is correct only if
   peak sample searching was enabled. If negative then the waveform
   already does not clip. The value is multiplied by 10 and rounded up. */
int CDECL lame_get_noclipGainChange(const lame_global_flags *);

/* user-specified scale factor required for preventing clipping. Value is
   correct only if peak sample searching was enabled and no user-specified
   scaling was performed. If negative then either the waveform already does
   not clip or the value cannot be determined */
float CDECL lame_get_noclipScale(const lame_global_flags *);

/* returns the limit of PCM samples, which one can pass in an encode call
   under the constrain of a provided buffer of size buffer_size */
int CDECL lame_get_maximum_number_of_samples(lame_t gfp, size_t buffer_size);




/*
 * REQUIRED:
 * sets more internal configuration based on data provided above.
 * returns -1 if something failed.
 */
int CDECL lame_init_params(lame_global_flags *);


/*
 * OPTIONAL:
 * get the version number, in a string. of the form:
 * "3.63 (beta)" or just "3.63".
 */
const char*  CDECL get_lame_version       ( void );
const char*  CDECL get_lame_short_version ( void );
const char*  CDECL get_lame_very_short_version ( void );
const char*  CDECL get_psy_version        ( void );
const char*  CDECL get_lame_url           ( void );
const char*  CDECL get_lame_os_bitness    ( void );

/*
 * OPTIONAL:
 * get the version numbers in numerical form.
 */
typedef struct {
    /* generic LAME version */
    int major;
    int minor;
    int alpha;               /* 0 if not an alpha version                  */
    int beta;                /* 0 if not a beta version                    */

    /* version of the psy model */
    int psy_major;
    int psy_minor;
    int psy_alpha;           /* 0 if not an alpha version                  */
    int psy_beta;            /* 0 if not a beta version                    */

    /* compile time features */
    const char *features;    /* Don't make assumptions about the contents! */
} lame_version_t;
void CDECL get_lame_version_numerical(lame_version_t *);


/*
 * OPTIONAL:
 * print internal lame configuration to message handler
 */
void CDECL lame_print_config(const lame_global_flags*  gfp);

void CDECL lame_print_internals( const lame_global_flags *gfp);


/*
 * input pcm data, output (maybe) mp3 frames.
 * This routine handles all buffering, resampling and filtering for you.
 *
 * return code     number of bytes output in mp3buf. Can be 0
 *                 -1:  mp3buf was too small
 *                 -2:  malloc() problem
 *                 -3:  lame_init_params() not called
 *                 -4:  psycho acoustic problems
 *
 * The required mp3buf_size can be computed from num_samples,
 * samplerate and encoding rate, but here is a worst case estimate:
 *
 * mp3buf_size in bytes = 1.25*num_samples + 7200
 *
 * I think a tighter bound could be:  (mt, March 2000)
 * MPEG1:
 *    num_samples*(bitrate/8)/samplerate + 4*1152*(bitrate/8)/samplerate + 512
 * MPEG2:
 *    num_samples*(bitrate/8)/samplerate + 4*576*(bitrate/8)/samplerate + 256
 *
 * but test first if you use that!
 *
 * set mp3buf_size = 0 and LAME will not check if mp3buf_size is
 * large enough.
 *
 * NOTE:
 * if gfp->num_channels=2, but gfp->mode = 3 (mono), the L & R channels
 * will be averaged into the L channel before encoding only the L channel
 * This will overwrite the data in buffer_l[] and buffer_r[].
 *
*/
int CDECL lame_encode_buffer (
        lame_global_flags*  gfp,           /* global context handle         */
        const short int     buffer_l [],   /* PCM data for left channel     */
        const short int     buffer_r [],   /* PCM data for right channel    */
        const int           nsamples,      /* number of samples per channel */
        unsigned char*      mp3buf,        /* pointer to encoded MP3 stream */
        const int           mp3buf_size ); /* number of valid octets in this
                                              stream                        */

/*
 * as above, but input has L & R channel data interleaved.
 * NOTE:
 * num_samples = number of samples in the L (or R)
 * channel, not the total number of samples in pcm[]
 */
int CDECL lame_encode_buffer_interleaved(
        lame_global_flags*  gfp,           /* global context handlei        */
        short int           pcm[],         /* PCM data for left and right
                                              channel, interleaved          */
        int                 num_samples,   /* number of samples per channel,
                                              _not_ number of samples in
                                              pcm[]                         */
        unsigned char*      mp3buf,        /* pointer to encoded MP3 stream */
        int                 mp3buf_size ); /* number of valid octets in this
                                              stream                        */


/* as lame_encode_buffer, but for 'float's.
 * !! NOTE: !! data must still be scaled to be in the same range as
 * short int, +/- 32768
 */
int CDECL lame_encode_buffer_float(
        lame_global_flags*  gfp,           /* global context handle         */
        const float         pcm_l [],      /* PCM data for left channel     */
        const float         pcm_r [],      /* PCM data for right channel    */
        const int           nsamples,      /* number of samples per channel */
        unsigned char*      mp3buf,        /* pointer to encoded MP3 stream */
        const int           mp3buf_size ); /* number of valid octets in this
                                              stream                        */

/* as lame_encode_buffer, but for 'float's.
 * !! NOTE: !! data must be scaled to +/- 1 full scale
 */
int CDECL lame_encode_buffer_ieee_float(
        lame_t          gfp,
        const float     pcm_l [],          /* PCM data for left channel     */
        const float     pcm_r [],          /* PCM data for right channel    */
        const int       nsamples,
        unsigned char * mp3buf,
        const int       mp3buf_size);
int CDECL lame_encode_buffer_interleaved_ieee_float(
        lame_t          gfp,
        const float     pcm[],             /* PCM data for left and right
                                              channel, interleaved          */
        const int       nsamples,
        unsigned char * mp3buf,
        const int       mp3buf_size);

/* as lame_encode_buffer, but for 'double's.
 * !! NOTE: !! data must be scaled to +/- 1 full scale
 */
int CDECL lame_encode_buffer_ieee_double(
        lame_t          gfp,
        const double    pcm_l [],          /* PCM data for left channel     */
        const double    pcm_r [],          /* PCM data for right channel    */
        const int       nsamples,
        unsigned char * mp3buf,
        const int       mp3buf_size);
int CDECL lame_encode_buffer_interleaved_ieee_double(
        lame_t          gfp,
        const double    pcm[],             /* PCM data for left and right
                                              channel, interleaved          */
        const int       nsamples,
        unsigned char * mp3buf,
        const int       mp3buf_size);

/* as lame_encode_buffer, but for long's
 * !! NOTE: !! data must still be scaled to be in the same range as
 * short int, +/- 32768
 *
 * This scaling was a mistake (doesn't allow one to exploit full
 * precision of type 'long'.  Use lame_encode_buffer_long2() instead.
 *
 */
int CDECL lame_encode_buffer_long(
        lame_global_flags*  gfp,           /* global context handle         */
        const long     buffer_l [],       /* PCM data for left channel     */
        const long     buffer_r [],       /* PCM data for right channel    */
        const int           nsamples,      /* number of samples per channel */
        unsigned char*      mp3buf,        /* pointer to encoded MP3 stream */
        const int           mp3buf_size ); /* number of valid octets in this
                                              stream                        */

/* Same as lame_encode_buffer_long(), but with correct scaling.
 * !! NOTE: !! data must still be scaled to be in the same range as
 * type 'long'.   Data should be in the range:  +/- 2^(8*size(long)-1)
 *
 */
int CDECL lame_encode_buffer_long2(
        lame_global_flags*  gfp,           /* global context handle         */
        const long     buffer_l [],       /* PCM data for left channel     */
        const long     buffer_r [],       /* PCM data for right channel    */
        const int           nsamples,      /* number of samples per channel */
        unsigned char*      mp3buf,        /* pointer to encoded MP3 stream */
        const int           mp3buf_size ); /* number of valid octets in this
                                              stream                        */

/* as lame_encode_buffer, but for int's
 * !! NOTE: !! input should be scaled to the maximum range of 'int'
 * If int is 4 bytes, then the values should range from
 * +/- 2147483648.
 *
 * This routine does not (and cannot, without loosing precision) use
 * the same scaling as the rest of the lame_encode_buffer() routines.
 *
 */
int CDECL lame_encode_buffer_int(
        lame_global_flags*  gfp,           /* global context handle         */
        const int      buffer_l [],       /* PCM data for left channel     */
        const int      buffer_r [],       /* PCM data for right channel    */
        const int           nsamples,      /* number of samples per channel */
        unsigned char*      mp3buf,        /* pointer to encoded MP3 stream */
        const int           mp3buf_size ); /* number of valid octets in this
                                              stream                        */

/*
 * as above, but for interleaved data.
 * !! NOTE: !! data must still be scaled to be in the same range as
 * type 'int32_t'.   Data should be in the range:  +/- 2^(8*size(int32_t)-1)
 * NOTE:
 * num_samples = number of samples in the L (or R)
 * channel, not the total number of samples in pcm[]
 */
int
lame_encode_buffer_interleaved_int(
        lame_t          gfp,
        const int       pcm [],            /* PCM data for left and right
                                              channel, interleaved          */
        const int       nsamples,          /* number of samples per channel,
                                              _not_ number of samples in
                                              pcm[]                         */
        unsigned char*  mp3buf,            /* pointer to encoded MP3 stream */
        const int       mp3buf_size );     /* number of valid octets in this
                                              stream                        */



/*
 * REQUIRED:
 * lame_encode_flush will flush the intenal PCM buffers, padding with
 * 0's to make sure the final frame is complete, and then flush
 * the internal MP3 buffers, and thus may return a
 * final few mp3 frames.  'mp3buf' should be at least 7200 bytes long
 * to hold all possible emitted data.
 *
 * will also write id3v1 tags (if any) into the bitstream
 *
 * return code = number of bytes output to mp3buf. Can be 0
 */
int CDECL lame_encode_flush(
        lame_global_flags *  gfp,    /* global context handle                 */
        unsigned char*       mp3buf, /* pointer to encoded MP3 stream         */
        int                  size);  /* number of valid octets in this stream */

/*
 * OPTIONAL:
 * lame_encode_flush_nogap will flush the internal mp3 buffers and pad
 * the last frame with ancillary data so it is a complete mp3 frame.
 *
 * 'mp3buf' should be at least 7200 bytes long
 * to hold all possible emitted data.
 *
 * After a call to this routine, the outputed mp3 data is complete, but
 * you may continue to encode new PCM samples and write future mp3 data
 * to a different file.  The two mp3 files will play back with no gaps
 * if they are concatenated together.
 *
 * This routine will NOT write id3v1 tags into the bitstream.
 *
 * return code = number of bytes output to mp3buf. Can be 0
 */
int CDECL lame_encode_flush_nogap(
        lame_global_flags *  gfp,    /* global context handle                 */
        unsigned char*       mp3buf, /* pointer to encoded MP3 stream         */
        int                  size);  /* number of valid octets in this stream */

/*
 * OPTIONAL:
 * Normally, this is called by lame_init_params().  It writes id3v2 and
 * Xing headers into the front of the bitstream, and sets frame counters
 * and bitrate histogram data to 0.  You can also call this after
 * lame_encode_flush_nogap().
 */
int CDECL lame_init_bitstream(
        lame_global_flags *  gfp);    /* global context handle                 */



/*
 * OPTIONAL:    some simple statistics
 * a bitrate histogram to visualize the distribution of used frame sizes
 * a stereo mode histogram to visualize the distribution of used stereo
 *   modes, useful in joint-stereo mode only
 *   0: LR    left-right encoded
 *   1: LR-I  left-right and intensity encoded (currently not supported)
 *   2: MS    mid-side encoded
 *   3: MS-I  mid-side and intensity encoded (currently not supported)
 *
 * attention: don't call them after lame_encode_finish
 * suggested: lame_encode_flush -> lame_*_hist -> lame_close
 */

void CDECL lame_bitrate_hist(
        const lame_global_flags * gfp,
        int bitrate_count[14] );
void CDECL lame_bitrate_kbps(
        const lame_global_flags * gfp,
        int bitrate_kbps [14] );
void CDECL lame_stereo_mode_hist(
        const lame_global_flags * gfp,
        int stereo_mode_count[4] );

void CDECL lame_bitrate_stereo_mode_hist (
        const lame_global_flags * gfp,
        int bitrate_stmode_count[14][4] );

void CDECL lame_block_type_hist (
        const lame_global_flags * gfp,
        int btype_count[6] );

void CDECL lame_bitrate_block_type_hist (
        const lame_global_flags * gfp,
        int bitrate_btype_count[14][6] );

#if (DEPRECATED_OR_OBSOLETE_CODE_REMOVED && 0)
#else
/*
 * OPTIONAL:
 * lame_mp3_tags_fid will rewrite a Xing VBR tag to the mp3 file with file
 * pointer fid.  These calls perform forward and backwards seeks, so make
 * sure fid is a real file.  Make sure lame_encode_flush has been called,
 * and all mp3 data has been written to the file before calling this
 * function.
 * NOTE:
 * if VBR  tags are turned off by the user, or turned off by LAME because
 * the output is not a regular file, this call does nothing
 * NOTE:
 * LAME wants to read from the file to skip an optional ID3v2 tag, so
 * make sure you opened the file for writing and reading.
 * NOTE:
 * You can call lame_get_lametag_frame instead, if you want to insert
 * the lametag yourself.
*/
void CDECL lame_mp3_tags_fid(lame_global_flags *, FILE* fid);
#endif

/*
 * OPTIONAL:
 * lame_get_lametag_frame copies the final LAME-tag into 'buffer'.
 * The function returns the number of bytes copied into buffer, or
 * the required buffer size, if the provided buffer is too small.
 * Function failed, if the return value is larger than 'size'!
 * Make sure lame_encode flush has been called before calling this function.
 * NOTE:
 * if VBR  tags are turned off by the user, or turned off by LAME,
 * this call does nothing and returns 0.
 * NOTE:
 * LAME inserted an empty frame in the beginning of mp3 audio data,
 * which you have to replace by the final LAME-tag frame after encoding.
 * In case there is no ID3v2 tag, usually this frame will be the very first
 * data in your mp3 file. If you put some other leading data into your
 * file, you'll have to do some bookkeeping about where to write this buffer.
 */
size_t CDECL lame_get_lametag_frame(
        const lame_global_flags *, unsigned char* buffer, size_t size);

/*
 * REQUIRED:
 * final call to free all remaining buffers
 */
int  CDECL lame_close (lame_global_flags *);

#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/*
 * OBSOLETE:
 * lame_encode_finish combines lame_encode_flush() and lame_close() in
 * one call.  However, once this call is made, the statistics routines
 * will no longer work because the data will have been cleared, and
 * lame_mp3_tags_fid() cannot be called to add data to the VBR header
 */
int CDECL lame_encode_finish(
        lame_global_flags*  gfp,
        unsigned char*      mp3buf,
        int                 size );
#endif






/*********************************************************************
 *
 * decoding
 *
 * a simple interface to mpglib, part of mpg123, is also included if
 * libmp3lame is compiled with HAVE_MPGLIB
 *
 *********************************************************************/

struct hip_global_struct;
typedef struct hip_global_struct hip_global_flags;
typedef hip_global_flags *hip_t;


typedef struct {
  int header_parsed;   /* 1 if header was parsed and following data was
                          computed                                       */
  int stereo;          /* number of channels                             */
  int samplerate;      /* sample rate                                    */
  int bitrate;         /* bitrate                                        */
  int mode;            /* mp3 frame type                                 */
  int mode_ext;        /* mp3 frame type                                 */
  int framesize;       /* number of samples per mp3 frame                */

  /* this data is only computed if mpglib detects a Xing VBR header */
  unsigned long nsamp; /* number of samples in mp3 file.                 */
  int totalframes;     /* total number of frames in mp3 file             */

  /* this data is not currently computed by the mpglib routines */
  int framenum;        /* frames decoded counter                         */
} mp3data_struct;

/* required call to initialize decoder */
hip_t CDECL hip_decode_init(void);

/* cleanup call to exit decoder  */
int CDECL hip_decode_exit(hip_t gfp);

/* HIP reporting functions */
void CDECL hip_set_errorf(hip_t gfp, lame_report_function f);
void CDECL hip_set_debugf(hip_t gfp, lame_report_function f);
void CDECL hip_set_msgf  (hip_t gfp, lame_report_function f);

/*********************************************************************
 * input 1 mp3 frame, output (maybe) pcm data.
 *
 *  nout = hip_decode(hip, mp3buf,len,pcm_l,pcm_r);
 *
 * input:
 *    len          :  number of bytes of mp3 data in mp3buf
 *    mp3buf[len]  :  mp3 data to be decoded
 *
 * output:
 *    nout:  -1    : decoding error
 *            0    : need more data before we can complete the decode
 *           >0    : returned 'nout' samples worth of data in pcm_l,pcm_r
 *    pcm_l[nout]  : left channel data
 *    pcm_r[nout]  : right channel data
 *
 *********************************************************************/
int CDECL hip_decode( hip_t           gfp
                    , unsigned char * mp3buf
                    , size_t          len
                    , short           pcm_l[]
                    , short           pcm_r[]
                    );

/* same as hip_decode, and also returns mp3 header data */
int CDECL hip_decode_headers( hip_t           gfp
                            , unsigned char*  mp3buf
                            , size_t          len
                            , short           pcm_l[]
                            , short           pcm_r[]
                            , mp3data_struct* mp3data
                            );

/* same as hip_decode, but returns at most one frame */
int CDECL hip_decode1( hip_t          gfp
                     , unsigned char* mp3buf
                     , size_t         len
                     , short          pcm_l[]
                     , short          pcm_r[]
                     );

/* same as hip_decode1, but returns at most one frame and mp3 header data */
int CDECL hip_decode1_headers( hip_t           gfp
                             , unsigned char*  mp3buf
                             , size_t          len
                             , short           pcm_l[]
                             , short           pcm_r[]
                             , mp3data_struct* mp3data
                             );

/* same as hip_decode1_headers, but also returns enc_delay and enc_padding
   from VBR Info tag, (-1 if no info tag was found) */
int CDECL hip_decode1_headersB( hip_t gfp
                              , unsigned char*   mp3buf
                              , size_t           len
                              , short            pcm_l[]
                              , short            pcm_r[]
                              , mp3data_struct*  mp3data
                              , int             *enc_delay
                              , int             *enc_padding
                              );



/* OBSOLETE:
 * lame_decode... functions are there to keep old code working
 * but it is strongly recommended to replace calls by hip_decode...
 * function calls, see above.
 */
#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
int CDECL lame_decode_init(void);
int CDECL lame_decode(
        unsigned char *  mp3buf,
        int              len,
        short            pcm_l[],
        short            pcm_r[] );
int CDECL lame_decode_headers(
        unsigned char*   mp3buf,
        int              len,
        short            pcm_l[],
        short            pcm_r[],
        mp3data_struct*  mp3data );
int CDECL lame_decode1(
        unsigned char*  mp3buf,
        int             len,
        short           pcm_l[],
        short           pcm_r[] );
int CDECL lame_decode1_headers(
        unsigned char*   mp3buf,
        int              len,
        short            pcm_l[],
        short            pcm_r[],
        mp3data_struct*  mp3data );
int CDECL lame_decode1_headersB(
        unsigned char*   mp3buf,
        int              len,
        short            pcm_l[],
        short            pcm_r[],
        mp3data_struct*  mp3data,
        int              *enc_delay,
        int              *enc_padding );
int CDECL lame_decode_exit(void);

#endif /* obsolete lame_decode API calls */


/*********************************************************************
 *
 * id3tag stuff
 *
 *********************************************************************/

/*
 * id3tag.h -- Interface to write ID3 version 1 and 2 tags.
 *
 * Copyright (C) 2000 Don Melton.
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Library General Public
 * License as published by the Free Software Foundation; either
 * version 2 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Library General Public License for more details.
 *
 * You should have received a copy of the GNU Library General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA 02111-1307, USA.
 */

/* utility to obtain alphabetically sorted list of genre names with numbers */
void CDECL id3tag_genre_list(
        void (*handler)(int, const char *, void *),
        void*  cookie);

void CDECL id3tag_init     (lame_t gfp);

/* force addition of version 2 tag */
void CDECL id3tag_add_v2   (lame_t gfp);

/* add only a version 1 tag */
void CDECL id3tag_v1_only  (lame_t gfp);

/* add only a version 2 tag */
void CDECL id3tag_v2_only  (lame_t gfp);

/* pad version 1 tag with spaces instead of nulls */
void CDECL id3tag_space_v1 (lame_t gfp);

/* pad version 2 tag with extra 128 bytes */
void CDECL id3tag_pad_v2   (lame_t gfp);

/* pad version 2 tag with extra n bytes */
void CDECL id3tag_set_pad  (lame_t gfp, size_t n);

void CDECL id3tag_set_title(lame_t gfp, const char* title);
void CDECL id3tag_set_artist(lame_t gfp, const char* artist);
void CDECL id3tag_set_album(lame_t gfp, const char* album);
void CDECL id3tag_set_year(lame_t gfp, const char* year);
void CDECL id3tag_set_comment(lame_t gfp, const char* comment);
            
/* return -1 result if track number is out of ID3v1 range
                    and ignored for ID3v1 */
int CDECL id3tag_set_track(lame_t gfp, const char* track);

/* return non-zero result if genre name or number is invalid
  result 0: OK
  result -1: genre number out of range
  result -2: no valid ID3v1 genre name, mapped to ID3v1 'Other'
             but taken as-is for ID3v2 genre tag */
int CDECL id3tag_set_genre(lame_t gfp, const char* genre);

/* return non-zero result if field name is invalid */
int CDECL id3tag_set_fieldvalue(lame_t gfp, const char* fieldvalue);

/* return non-zero result if image type is invalid */
int CDECL id3tag_set_albumart(lame_t gfp, const char* image, size_t size);

/* lame_get_id3v1_tag copies ID3v1 tag into buffer.
 * Function returns number of bytes copied into buffer, or number
 * of bytes rquired if buffer 'size' is too small.
 * Function fails, if returned value is larger than 'size'.
 * NOTE:
 * This functions does nothing, if user/LAME disabled ID3v1 tag.
 */
size_t CDECL lame_get_id3v1_tag(lame_t gfp, unsigned char* buffer, size_t size);

/* lame_get_id3v2_tag copies ID3v2 tag into buffer.
 * Function returns number of bytes copied into buffer, or number
 * of bytes rquired if buffer 'size' is too small.
 * Function fails, if returned value is larger than 'size'.
 * NOTE:
 * This functions does nothing, if user/LAME disabled ID3v2 tag.
 */
size_t CDECL lame_get_id3v2_tag(lame_t gfp, unsigned char* buffer, size_t size);

/* normaly lame_init_param writes ID3v2 tags into the audio stream
 * Call lame_set_write_id3tag_automatic(gfp, 0) before lame_init_param
 * to turn off this behaviour and get ID3v2 tag with above function
 * write it yourself into your file.
 */
void CDECL lame_set_write_id3tag_automatic(lame_global_flags * gfp, int);
int CDECL lame_get_write_id3tag_automatic(lame_global_flags const* gfp);

/* experimental */
int CDECL id3tag_set_textinfo_latin1(lame_t gfp, char const *id, char const *text);

/* experimental */
int CDECL id3tag_set_comment_latin1(lame_t gfp, char const *lang, char const *desc, char const *text);

#if DEPRECATED_OR_OBSOLETE_CODE_REMOVED
#else
/* experimental */
int CDECL id3tag_set_textinfo_ucs2(lame_t gfp, char const *id, unsigned short const *text);

/* experimental */
int CDECL id3tag_set_comment_ucs2(lame_t gfp, char const *lang,
                                  unsigned short const *desc, unsigned short const *text);

/* experimental */
int CDECL id3tag_set_fieldvalue_ucs2(lame_t gfp, const unsigned short *fieldvalue);
#endif

/* experimental */
int CDECL id3tag_set_fieldvalue_utf16(lame_t gfp, const unsigned short *fieldvalue);

/* experimental */
int CDECL id3tag_set_textinfo_utf16(lame_t gfp, char const *id, unsigned short const *text);

/* experimental */
int CDECL id3tag_set_comment_utf16(lame_t gfp, char const *lang, unsigned short const *desc, unsigned short const *text);


/***********************************************************************
*
*  list of valid bitrates [kbps] & sample frequencies [Hz].
*  first index: 0: MPEG-2   values  (sample frequencies 16...24 kHz)
*               1: MPEG-1   values  (sample frequencies 32...48 kHz)
*               2: MPEG-2.5 values  (sample frequencies  8...12 kHz)
***********************************************************************/

extern const int     bitrate_table    [3][16];
extern const int     samplerate_table [3][ 4];

/* access functions for use in DLL, global vars are not exported */
int CDECL lame_get_bitrate(int mpeg_version, int table_index);
int CDECL lame_get_samplerate(int mpeg_version, int table_index);


/* maximum size of albumart image (128KB), which affects LAME_MAXMP3BUFFER
   as well since lame_encode_buffer() also returns ID3v2 tag data */
#define LAME_MAXALBUMART    (128 * 1024)

/* maximum size of mp3buffer needed if you encode at most 1152 samples for
   each call to lame_encode_buffer.  see lame_encode_buffer() below  
   (LAME_MAXMP3BUFFER is now obsolete)  */
#define LAME_MAXMP3BUFFER   (16384 + LAME_MAXALBUMART)


typedef enum {
    LAME_OKAY             =   0,
    LAME_NOERROR          =   0,
    LAME_GENERICERROR     =  -1,
    LAME_NOMEM            = -10,
    LAME_BADBITRATE       = -11,
    LAME_BADSAMPFREQ      = -12,
    LAME_INTERNALERROR    = -13,

    FRONTEND_READERROR    = -80,
    FRONTEND_WRITEERROR   = -81,
    FRONTEND_FILETOOLARGE = -82

} lame_errorcodes_t;

#if defined(__cplusplus)
}
#endif
#endif /* LAME_LAME_H */

