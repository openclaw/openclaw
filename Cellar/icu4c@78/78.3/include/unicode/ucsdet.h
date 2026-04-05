// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 **********************************************************************
 *   Copyright (C) 2005-2013, International Business Machines
 *   Corporation and others.  All Rights Reserved.
 **********************************************************************
 *   file name:  ucsdet.h
 *   encoding:   UTF-8
 *   indentation:4
 *
 *   created on: 2005Aug04
 *   created by: Andy Heninger
 *
 *   ICU Character Set Detection, API for C
 *
 *   Draft version 18 Oct 2005
 *
 */

#ifndef __UCSDET_H
#define __UCSDET_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_CONVERSION

#include "unicode/uenum.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C API: Charset Detection API
 *
 * This API provides a facility for detecting the
 * charset or encoding of character data in an unknown text format.
 * The input data can be from an array of bytes.
 * <p>
 * Character set detection is at best an imprecise operation.  The detection
 * process will attempt to identify the charset that best matches the characteristics
 * of the byte data, but the process is partly statistical in nature, and
 * the results can not be guaranteed to always be correct.
 * <p>
 * For best accuracy in charset detection, the input data should be primarily
 * in a single language, and a minimum of a few hundred bytes worth of plain text
 * in the language are needed.  The detection process will attempt to
 * ignore html or xml style markup that could otherwise obscure the content.
 * <p>
 * An alternative to the ICU Charset Detector is the
 * Compact Encoding Detector, https://github.com/google/compact_enc_det.
 * It often gives more accurate results, especially with short input samples.
 */
 

struct UCharsetDetector;
/**
  * Structure representing a charset detector
  * @stable ICU 3.6
  */
typedef struct UCharsetDetector UCharsetDetector;

struct UCharsetMatch;
/**
  *  Opaque structure representing a match that was identified
  *  from a charset detection operation.
  *  @stable ICU 3.6
  */
typedef struct UCharsetMatch UCharsetMatch;

/**
  *  Open a charset detector.
  *
  *  @param status Any error conditions occurring during the open
  *                operation are reported back in this variable.
  *  @return the newly opened charset detector.
  *  @stable ICU 3.6
  */
U_CAPI UCharsetDetector * U_EXPORT2
ucsdet_open(UErrorCode   *status);

/**
  * Close a charset detector.  All storage and any other resources
  *   owned by this charset detector will be released.  Failure to
  *   close a charset detector when finished with it can result in
  *   memory leaks in the application.
  *
  *  @param ucsd  The charset detector to be closed.
  *  @stable ICU 3.6
  */
U_CAPI void U_EXPORT2
ucsdet_close(UCharsetDetector *ucsd);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUCharsetDetectorPointer
 * "Smart pointer" class, closes a UCharsetDetector via ucsdet_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUCharsetDetectorPointer, UCharsetDetector, ucsdet_close);

U_NAMESPACE_END

#endif

/**
  * Set the input byte data whose charset is to detected.
  *
  * Ownership of the input  text byte array remains with the caller.
  * The input string must not be altered or deleted until the charset
  * detector is either closed or reset to refer to different input text.
  *
  * @param ucsd   the charset detector to be used.
  * @param textIn the input text of unknown encoding.   .
  * @param len    the length of the input text, or -1 if the text
  *               is NUL terminated.
  * @param status any error conditions are reported back in this variable.
  *
  * @stable ICU 3.6
  */
U_CAPI void U_EXPORT2
ucsdet_setText(UCharsetDetector *ucsd, const char *textIn, int32_t len, UErrorCode *status);


/** Set the declared encoding for charset detection.
 *  The declared encoding of an input text is an encoding obtained
 *  by the user from an http header or xml declaration or similar source that
 *  can be provided as an additional hint to the charset detector.
 *
 *  How and whether the declared encoding will be used during the
 *  detection process is TBD.
 *
 * @param ucsd      the charset detector to be used.
 * @param encoding  an encoding for the current data obtained from
 *                  a header or declaration or other source outside
 *                  of the byte data itself.
 * @param length    the length of the encoding name, or -1 if the name string
 *                  is NUL terminated.
 * @param status    any error conditions are reported back in this variable.
 *
 * @stable ICU 3.6
 */
U_CAPI void U_EXPORT2
ucsdet_setDeclaredEncoding(UCharsetDetector *ucsd, const char *encoding, int32_t length, UErrorCode *status);


/**
 * Return the charset that best matches the supplied input data.
 * 
 * Note though, that because the detection 
 * only looks at the start of the input data,
 * there is a possibility that the returned charset will fail to handle
 * the full set of input data.
 * <p>
 * The returned UCharsetMatch object is owned by the UCharsetDetector.
 * It will remain valid until the detector input is reset, or until
 * the detector is closed.
 * <p>
 * The function will fail if
 *  <ul>
 *    <li>no charset appears to match the data.</li>
 *    <li>no input text has been provided</li>
 *  </ul>
 *
 * @param ucsd      the charset detector to be used.
 * @param status    any error conditions are reported back in this variable.
 * @return          a UCharsetMatch  representing the best matching charset,
 *                  or NULL if no charset matches the byte data.
 *
 * @stable ICU 3.6
 */
U_CAPI const UCharsetMatch * U_EXPORT2
ucsdet_detect(UCharsetDetector *ucsd, UErrorCode *status);
    

/**
 *  Find all charset matches that appear to be consistent with the input,
 *  returning an array of results.  The results are ordered with the
 *  best quality match first.
 *
 *  Because the detection only looks at a limited amount of the
 *  input byte data, some of the returned charsets may fail to handle
 *  the all of input data.
 *  <p>
 *  The returned UCharsetMatch objects are owned by the UCharsetDetector.
 *  They will remain valid until the detector is closed or modified
 *  
 * <p>
 * Return an error if 
 *  <ul>
 *    <li>no charsets appear to match the input data.</li>
 *    <li>no input text has been provided</li>
 *  </ul>
 * 
 * @param ucsd          the charset detector to be used.
 * @param matchesFound  pointer to a variable that will be set to the
 *                      number of charsets identified that are consistent with
 *                      the input data.  Output only.
 * @param status        any error conditions are reported back in this variable.
 * @return              A pointer to an array of pointers to UCharSetMatch objects.
 *                      This array, and the UCharSetMatch instances to which it refers,
 *                      are owned by the UCharsetDetector, and will remain valid until
 *                      the detector is closed or modified.
 * @stable ICU 3.6
 */
U_CAPI const UCharsetMatch ** U_EXPORT2
ucsdet_detectAll(UCharsetDetector *ucsd, int32_t *matchesFound, UErrorCode *status);



/**
 *  Get the name of the charset represented by a UCharsetMatch.
 *
 *  The storage for the returned name string is owned by the
 *  UCharsetMatch, and will remain valid while the UCharsetMatch
 *  is valid.
 *
 *  The name returned is suitable for use with the ICU conversion APIs.
 *
 *  @param ucsm    The charset match object.
 *  @param status  Any error conditions are reported back in this variable.
 *  @return        The name of the matching charset.
 *
 *  @stable ICU 3.6
 */
U_CAPI const char * U_EXPORT2
ucsdet_getName(const UCharsetMatch *ucsm, UErrorCode *status);

/**
 *  Get a confidence number for the quality of the match of the byte
 *  data with the charset.  Confidence numbers range from zero to 100,
 *  with 100 representing complete confidence and zero representing
 *  no confidence.
 *
 *  The confidence values are somewhat arbitrary.  They define an
 *  an ordering within the results for any single detection operation
 *  but are not generally comparable between the results for different input.
 *
 *  A confidence value of ten does have a general meaning - it is used
 *  for charsets that can represent the input data, but for which there
 *  is no other indication that suggests that the charset is the correct one.
 *  Pure 7 bit ASCII data, for example, is compatible with a
 *  great many charsets, most of which will appear as possible matches
 *  with a confidence of 10.
 *
 *  @param ucsm    The charset match object.
 *  @param status  Any error conditions are reported back in this variable.
 *  @return        A confidence number for the charset match.
 *
 *  @stable ICU 3.6
 */
U_CAPI int32_t U_EXPORT2
ucsdet_getConfidence(const UCharsetMatch *ucsm, UErrorCode *status);

/**
 *  Get the RFC 3066 code for the language of the input data.
 *
 *  The Charset Detection service is intended primarily for detecting
 *  charsets, not language.  For some, but not all, charsets, a language is
 *  identified as a byproduct of the detection process, and that is what
 *  is returned by this function.
 *
 *  CAUTION:
 *    1.  Language information is not available for input data encoded in
 *        all charsets. In particular, no language is identified
 *        for UTF-8 input data.
 *
 *    2.  Closely related languages may sometimes be confused.
 *
 *  If more accurate language detection is required, a linguistic
 *  analysis package should be used.
 *
 *  The storage for the returned name string is owned by the
 *  UCharsetMatch, and will remain valid while the UCharsetMatch
 *  is valid.
 *
 *  @param ucsm    The charset match object.
 *  @param status  Any error conditions are reported back in this variable.
 *  @return        The RFC 3066 code for the language of the input data, or
 *                 an empty string if the language could not be determined.
 *
 *  @stable ICU 3.6
 */
U_CAPI const char * U_EXPORT2
ucsdet_getLanguage(const UCharsetMatch *ucsm, UErrorCode *status);


/**
  *  Get the entire input text as a UChar string, placing it into
  *  a caller-supplied buffer.  A terminating
  *  NUL character will be appended to the buffer if space is available.
  *
  *  The number of UChars in the output string, not including the terminating
  *  NUL, is returned. 
  *
  *  If the supplied buffer is smaller than required to hold the output,
  *  the contents of the buffer are undefined.  The full output string length
  *  (in UChars) is returned as always, and can be used to allocate a buffer
  *  of the correct size.
  *
  *
  * @param ucsm    The charset match object.
  * @param buf     A UChar buffer to be filled with the converted text data.
  * @param cap     The capacity of the buffer in UChars.
  * @param status  Any error conditions are reported back in this variable.
  * @return        The number of UChars in the output string.
  *
  * @stable ICU 3.6
  */
U_CAPI  int32_t U_EXPORT2
ucsdet_getUChars(const UCharsetMatch *ucsm,
                 UChar *buf, int32_t cap, UErrorCode *status);



/**
  *  Get an iterator over the set of all detectable charsets - 
  *  over the charsets that are known to the charset detection
  *  service.
  *
  *  The returned UEnumeration provides access to the names of
  *  the charsets.
  *
  *  <p>
  *  The state of the Charset detector that is passed in does not
  *  affect the result of this function, but requiring a valid, open
  *  charset detector as a parameter insures that the charset detection
  *  service has been safely initialized and that the required detection
  *  data is available.
  *
  *  <p>
  *  <b>Note:</b> Multiple different charset encodings in a same family may use
  *  a single shared name in this implementation. For example, this method returns
  *  an array including "ISO-8859-1" (ISO Latin 1), but not including "windows-1252"
  *  (Windows Latin 1). However, actual detection result could be "windows-1252"
  *  when the input data matches Latin 1 code points with any points only available
  *  in "windows-1252".
  *
  *  @param ucsd a Charset detector.
  *  @param status  Any error conditions are reported back in this variable.
  *  @return an iterator providing access to the detectable charset names.
  *  @stable ICU 3.6
  */
U_CAPI  UEnumeration * U_EXPORT2
ucsdet_getAllDetectableCharsets(const UCharsetDetector *ucsd,  UErrorCode *status);

/**
  *  Test whether input filtering is enabled for this charset detector.
  *  Input filtering removes text that appears to be HTML or xml
  *  markup from the input before applying the code page detection
  *  heuristics.
  *
  *  @param ucsd  The charset detector to check.
  *  @return true if filtering is enabled.
  *  @stable ICU 3.6
  */

U_CAPI  UBool U_EXPORT2
ucsdet_isInputFilterEnabled(const UCharsetDetector *ucsd);


/**
 * Enable filtering of input text. If filtering is enabled,
 * text within angle brackets ("<" and ">") will be removed
 * before detection, which will remove most HTML or xml markup.
 *
 * @param ucsd   the charset detector to be modified.
 * @param filter <code>true</code> to enable input text filtering.
 * @return The previous setting.
 *
 * @stable ICU 3.6
 */
U_CAPI  UBool U_EXPORT2
ucsdet_enableInputFilter(UCharsetDetector *ucsd, UBool filter);

#ifndef U_HIDE_INTERNAL_API
/**
  *  Get an iterator over the set of detectable charsets -
  *  over the charsets that are enabled by the specified charset detector.
  *
  *  The returned UEnumeration provides access to the names of
  *  the charsets.
  *
  *  @param ucsd a Charset detector.
  *  @param status  Any error conditions are reported back in this variable.
  *  @return an iterator providing access to the detectable charset names by
  *  the specified charset detector.
  *  @internal
  */
U_CAPI UEnumeration * U_EXPORT2
ucsdet_getDetectableCharsets(const UCharsetDetector *ucsd,  UErrorCode *status);

/**
  * Enable or disable individual charset encoding.
  * A name of charset encoding must be included in the names returned by
  * {@link #ucsdet_getAllDetectableCharsets()}.
  *
  * @param ucsd a Charset detector.
  * @param encoding encoding the name of charset encoding.
  * @param enabled <code>true</code> to enable, or <code>false</code> to disable the
  *   charset encoding.
  * @param status receives the return status. When the name of charset encoding
  *   is not supported, U_ILLEGAL_ARGUMENT_ERROR is set.
  * @internal
  */
U_CAPI void U_EXPORT2
ucsdet_setDetectableCharset(UCharsetDetector *ucsd, const char *encoding, UBool enabled, UErrorCode *status);
#endif  /* U_HIDE_INTERNAL_API */

#endif
#endif   /* __UCSDET_H */


