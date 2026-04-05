// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 2000-2004, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
 *  ucnv_cb.h:
 *  External APIs for the ICU's codeset conversion library
 *  Helena Shih
 * 
 * Modification History:
 *
 *   Date        Name        Description
 */

/**
 * \file
 * \brief C API: UConverter functions to aid the writers of callbacks
 *
 * <h2> Callback API for UConverter </h2>
 * 
 * These functions are provided here for the convenience of the callback
 * writer. If you are just looking for callback functions to use, please
 * see ucnv_err.h.  DO NOT call these functions directly when you are 
 * working with converters, unless your code has been called as a callback
 * via ucnv_setFromUCallback or ucnv_setToUCallback !!
 * 
 * A note about error codes and overflow.  Unlike other ICU functions,
 * these functions do not expect the error status to be U_ZERO_ERROR.
 * Callbacks must be much more careful about their error codes.
 * The error codes used here are in/out parameters, which should be passed
 * back in the callback's error parameter.
 * 
 * For example, if you call ucnv_cbfromUWriteBytes to write data out 
 * to the output codepage, it may return U_BUFFER_OVERFLOW_ERROR if 
 * the data did not fit in the target. But this isn't a failing error, 
 * in fact, ucnv_cbfromUWriteBytes may be called AGAIN with the error
 * status still U_BUFFER_OVERFLOW_ERROR to attempt to write further bytes,
 * which will also go into the internal overflow buffers.
 * 
 * Concerning offsets, the 'offset' parameters here are relative to the start
 * of SOURCE.  For example, Suppose the string "ABCD" was being converted 
 * from Unicode into a codepage which doesn't have a mapping for 'B'.
 * 'A' will be written out correctly, but
 * The FromU Callback will be called on an unassigned character for 'B'.
 * At this point, this is the state of the world:
 *    Target:    A [..]     [points after A]
 *    Source:  A B [C] D    [points to C - B has been consumed]
 *             0 1  2  3 
 *    codePoint = "B"       [the unassigned codepoint] 
 * 
 * Now, suppose a callback wants to write the substitution character '?' to
 * the target. It calls ucnv_cbFromUWriteBytes() to write the ?. 
 * It should pass ZERO as the offset, because the offset as far as the 
 * callback is concerned is relative to the SOURCE pointer [which points 
 * before 'C'.]  If the callback goes into the args and consumes 'C' also,
 * it would call FromUWriteBytes with an offset of 1 (and advance the source
 * pointer).
 *
 */

#ifndef UCNV_CB_H
#define UCNV_CB_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_CONVERSION

#include "unicode/ucnv.h"
#include "unicode/ucnv_err.h"

/**
 * ONLY used by FromU callback functions.
 * Writes out the specified byte output bytes to the target byte buffer or to converter internal buffers.
 *
 * @param args callback fromUnicode arguments
 * @param source source bytes to write
 * @param length length of bytes to write
 * @param offsetIndex the relative offset index from callback.
 * @param err error status. If <TT>U_BUFFER_OVERFLOW</TT> is returned, then U_BUFFER_OVERFLOW <STRONG>must</STRONG> 
 * be returned to the user, because it means that not all data could be written into the target buffer, and some is 
 * in the converter error buffer.
 * @see ucnv_cbFromUWriteSub
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_cbFromUWriteBytes (UConverterFromUnicodeArgs *args,
                        const char* source,
                        int32_t length,
                        int32_t offsetIndex,
                        UErrorCode * err);

/**
 * ONLY used by FromU callback functions.  
 * This function will write out the correct substitution character sequence 
 * to the target.
 *
 * @param args callback fromUnicode arguments
 * @param offsetIndex the relative offset index from the current source pointer to be used
 * @param err error status. If <TT>U_BUFFER_OVERFLOW</TT> is returned, then U_BUFFER_OVERFLOW <STRONG>must</STRONG> 
 * be returned to the user, because it means that not all data could be written into the target buffer, and some is 
 * in the converter error buffer.
 * @see ucnv_cbFromUWriteBytes
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucnv_cbFromUWriteSub (UConverterFromUnicodeArgs *args,
                      int32_t offsetIndex,
                      UErrorCode * err);

/**
 * ONLY used by fromU callback functions.  
 * This function will write out the error character(s) to the target UChar buffer.
 *
 * @param args callback fromUnicode arguments
 * @param source pointer to pointer to first UChar to write [on exit: 1 after last UChar processed]
 * @param sourceLimit pointer after last UChar to write
 * @param offsetIndex the relative offset index from callback which will be set
 * @param err error status <TT>U_BUFFER_OVERFLOW</TT>
 * @see ucnv_cbToUWriteSub
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 ucnv_cbFromUWriteUChars(UConverterFromUnicodeArgs *args,
                             const UChar** source,
                             const UChar*  sourceLimit,
                             int32_t offsetIndex,
                             UErrorCode * err);

/**
 * ONLY used by ToU callback functions.
 *  This function will write out the specified characters to the target 
 * UChar buffer.
 *
 * @param args callback toUnicode arguments
 * @param source source string to write
 * @param length the length of source string
 * @param offsetIndex the relative offset index which will be written.
 * @param err error status <TT>U_BUFFER_OVERFLOW</TT>
 * @see ucnv_cbToUWriteSub
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 ucnv_cbToUWriteUChars (UConverterToUnicodeArgs *args,
                                             const UChar* source,
                                             int32_t length,
                                             int32_t offsetIndex,
                                             UErrorCode * err);

/**
 * ONLY used by ToU  callback functions.  
 * This function will write out the Unicode substitution character (U+FFFD).
 *
 * @param args callback fromUnicode arguments
 * @param offsetIndex the relative offset index from callback.
 * @param err error status <TT>U_BUFFER_OVERFLOW</TT>
 * @see ucnv_cbToUWriteUChars
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 ucnv_cbToUWriteSub (UConverterToUnicodeArgs *args,
                       int32_t offsetIndex,
                       UErrorCode * err);
#endif

#endif
