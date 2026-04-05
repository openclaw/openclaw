/*
******************************************************************************
*
* © 2016 and later: Unicode, Inc. and others.
* License & terms of use: http://www.unicode.org/copyright.html
*
******************************************************************************
*   file name:  ubiditransform.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2016jul24
*   created by: Lina Kemmel
*
*/

#ifndef UBIDITRANSFORM_H
#define UBIDITRANSFORM_H

#include "unicode/utypes.h"
#include "unicode/ubidi.h"
#include "unicode/uchar.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: Bidi Transformations
 */

/**
 * `UBiDiOrder` indicates the order of text.
 *
 * This bidi transformation engine supports all possible combinations (4 in
 * total) of input and output text order:
 *
 *   - <logical input, visual output>: unless the output direction is RTL, this
 *     corresponds to a normal operation of the Bidi algorithm as described in the
 *     Unicode Technical Report and implemented by `UBiDi` when the
 *     reordering mode is set to `UBIDI_REORDER_DEFAULT`. Visual RTL
 *     mode is not supported by `UBiDi` and is accomplished through
 *     reversing a visual LTR string,
 *
 *   - <visual input, logical output>: unless the input direction is RTL, this
 *     corresponds to an "inverse bidi algorithm" in `UBiDi` with the
 *     reordering mode set to `UBIDI_REORDER_INVERSE_LIKE_DIRECT`.
 *     Visual RTL mode is not not supported by `UBiDi` and is
 *     accomplished through reversing a visual LTR string,
 *
 *   - <logical input, logical output>: if the input and output base directions
 *     mismatch, this corresponds to the `UBiDi` implementation with the
 *     reordering mode set to `UBIDI_REORDER_RUNS_ONLY`; and if the
 *     input and output base directions are identical, the transformation engine
 *     will only handle character mirroring and Arabic shaping operations without
 *     reordering,
 *
 *   - <visual input, visual output>: this reordering mode is not supported by
 *     the `UBiDi` engine; it implies character mirroring, Arabic
 *     shaping, and - if the input/output base directions mismatch -  string
 *     reverse operations.
 * @see ubidi_setInverse
 * @see ubidi_setReorderingMode
 * @see UBIDI_REORDER_DEFAULT
 * @see UBIDI_REORDER_INVERSE_LIKE_DIRECT
 * @see UBIDI_REORDER_RUNS_ONLY
 * @stable ICU 58
 */
typedef enum {
    /** 0: Constant indicating a logical order.
      * This is the default for input text.
      * @stable ICU 58
      */
    UBIDI_LOGICAL = 0,
    /** 1: Constant indicating a visual order.
      * This is a default for output text.
      * @stable ICU 58
      */
    UBIDI_VISUAL
} UBiDiOrder;

/**
 * <code>UBiDiMirroring</code> indicates whether or not characters with the
 * "mirrored" property in RTL runs should be replaced with their mirror-image
 * counterparts.
 * @see UBIDI_DO_MIRRORING
 * @see ubidi_setReorderingOptions
 * @see ubidi_writeReordered
 * @see ubidi_writeReverse
 * @stable ICU 58
 */
typedef enum {
    /** 0: Constant indicating that character mirroring should not be
      * performed.
      * This is the default.
      * @stable ICU 58
      */
    UBIDI_MIRRORING_OFF = 0,
    /** 1: Constant indicating that character mirroring should be performed.
      * This corresponds to calling <code>ubidi_writeReordered</code> or
      * <code>ubidi_writeReverse</code> with the
      * <code>UBIDI_DO_MIRRORING</code> option bit set.
      * @stable ICU 58
      */
    UBIDI_MIRRORING_ON
} UBiDiMirroring;

/**
 * Forward declaration of the <code>UBiDiTransform</code> structure that stores
 * information used by the layout transformation engine.
 * @stable ICU 58
 */
typedef struct UBiDiTransform UBiDiTransform;

/**
 * Performs transformation of text from the bidi layout defined by the input
 * ordering scheme to the bidi layout defined by the output ordering scheme,
 * and applies character mirroring and Arabic shaping operations.<p>
 * In terms of <code>UBiDi</code>, such a transformation implies:
 * <ul>
 * <li>calling <code>ubidi_setReorderingMode</code> as needed (when the
 * reordering mode is other than normal),</li>
 * <li>calling <code>ubidi_setInverse</code> as needed (when text should be
 * transformed from a visual to a logical form),</li>
 * <li>resolving embedding levels of each character in the input text by
 * calling <code>ubidi_setPara</code>,</li>
 * <li>reordering the characters based on the computed embedding levels, also
 * performing character mirroring as needed, and streaming the result to the
 * output, by calling <code>ubidi_writeReordered</code>,</li>
 * <li>performing Arabic digit and letter shaping on the output text by calling
 * <code>u_shapeArabic</code>.</li>
 * </ul>
 * An "ordering scheme" encompasses the base direction and the order of text,
 * and these characteristics must be defined by the caller for both input and
 * output explicitly .<p>
 * There are 36 possible combinations of <input, output> ordering schemes,
 * which are partially supported by <code>UBiDi</code> already. Examples of the
 * currently supported combinations:
 * <ul>
 * <li><Logical LTR, Visual LTR>: this is equivalent to calling
 * <code>ubidi_setPara</code> with <code>paraLevel == UBIDI_LTR</code>,</li>
 * <li><Logical RTL, Visual LTR>: this is equivalent to calling
 * <code>ubidi_setPara</code> with <code>paraLevel == UBIDI_RTL</code>,</li>
 * <li><Logical Default ("Auto") LTR, Visual LTR>: this is equivalent to
 * calling <code>ubidi_setPara</code> with
 * <code>paraLevel == UBIDI_DEFAULT_LTR</code>,</li>
 * <li><Logical Default ("Auto") RTL, Visual LTR>: this is equivalent to
 * calling <code>ubidi_setPara</code> with
 * <code>paraLevel == UBIDI_DEFAULT_RTL</code>,</li>
 * <li><Visual LTR, Logical LTR>: this is equivalent to
 * calling <code>ubidi_setInverse(UBiDi*, true)</code> and then
 * <code>ubidi_setPara</code> with <code>paraLevel == UBIDI_LTR</code>,</li>
 * <li><Visual LTR, Logical RTL>: this is equivalent to
 * calling <code>ubidi_setInverse(UBiDi*, true)</code> and then
 * <code>ubidi_setPara</code> with <code>paraLevel == UBIDI_RTL</code>.</li>
 * </ul>
 * All combinations that involve the Visual RTL scheme are unsupported by
 * <code>UBiDi</code>, for instance:
 * <ul>
 * <li><Logical LTR, Visual RTL>,</li>
 * <li><Visual RTL, Logical RTL>.</li>
 * </ul>
 * <p>Example of usage of the transformation engine:<br>
 * <pre>
 * \code
 * UChar text1[] = {'a', 'b', 'c', 0x0625, '1', 0};
 * UChar text2[] = {'a', 'b', 'c', 0x0625, '1', 0};
 * UErrorCode errorCode = U_ZERO_ERROR;
 * // Run a transformation.
 * ubiditransform_transform(pBidiTransform,
 *          text1, -1, text2, -1,
 *          UBIDI_LTR, UBIDI_VISUAL,
 *          UBIDI_RTL, UBIDI_LOGICAL,
 *          UBIDI_MIRRORING_OFF,
 *          U_SHAPE_DIGITS_AN2EN | U_SHAPE_DIGIT_TYPE_AN_EXTENDED,
 *          &errorCode);
 * // Do something with text2.
 *  text2[4] = '2';
 * // Run a reverse transformation.
 * ubiditransform_transform(pBidiTransform,
 *          text2, -1, text1, -1,
 *          UBIDI_RTL, UBIDI_LOGICAL,
 *          UBIDI_LTR, UBIDI_VISUAL,
 *          UBIDI_MIRRORING_OFF,
 *          U_SHAPE_DIGITS_EN2AN | U_SHAPE_DIGIT_TYPE_AN_EXTENDED,
 *          &errorCode);
 *\endcode
 * </pre>
 * </p>
 *
 * @param pBiDiTransform A pointer to a <code>UBiDiTransform</code> object
 *        allocated with <code>ubiditransform_open()</code> or
 *        <code>NULL</code>.<p>
 *        This object serves for one-time setup to amortize initialization
 *        overheads. Use of this object is not thread-safe. All other threads
 *        should allocate a new <code>UBiDiTransform</code> object by calling
 *        <code>ubiditransform_open()</code> before using it. Alternatively,
 *        a caller can set this parameter to <code>NULL</code>, in which case
 *        the object will be allocated by the engine on the fly.</p>
 * @param src A pointer to the text that the Bidi layout transformations will
 *        be performed on.
 *        <p><strong>Note:</strong> the text must be (at least)
 *        <code>srcLength</code> long.</p>
 * @param srcLength The length of the text, in number of UChars. If
 *        <code>length == -1</code> then the text must be zero-terminated.
 * @param dest A pointer to where the processed text is to be copied.
 * @param destSize The size of the <code>dest</code> buffer, in number of
 *        UChars. If the <code>U_SHAPE_LETTERS_UNSHAPE</code> option is set,
 *        then the destination length could be as large as
 *        <code>srcLength * 2</code>. Otherwise, the destination length will
 *        not exceed <code>srcLength</code>. If the caller reserves the last
 *        position for zero-termination, it should be excluded from
 *        <code>destSize</code>.
 *        <p><code>destSize == -1</code> is allowed and makes sense when
 *        <code>dest</code> was holds some meaningful value, e.g. that of
 *        <code>src</code>. In this case <code>dest</code> must be
 *        zero-terminated.</p>
 * @param inParaLevel A base embedding level of the input as defined in
 *        <code>ubidi_setPara</code> documentation for the
 *        <code>paraLevel</code> parameter.
 * @param inOrder An order of the input, which can be one of the
 *        <code>UBiDiOrder</code> values.
 * @param outParaLevel A base embedding level of the output as defined in
 *        <code>ubidi_setPara</code> documentation for the
 *        <code>paraLevel</code> parameter.
 * @param outOrder An order of the output, which can be one of the
 *        <code>UBiDiOrder</code> values.
 * @param doMirroring Indicates whether or not to perform character mirroring,
 *        and can accept one of the <code>UBiDiMirroring</code> values.
 * @param shapingOptions Arabic digit and letter shaping options defined in the
 *        ushape.h documentation.
 *        <p><strong>Note:</strong> Direction indicator options are computed by
 *        the transformation engine based on the effective ordering schemes, so
 *        user-defined direction indicators will be ignored.</p>
 * @param pErrorCode A pointer to an error code value.
 *
 * @return The destination length, i.e. the number of UChars written to
 *         <code>dest</code>. If the transformation fails, the return value
 *         will be 0 (and the error code will be written to
 *         <code>pErrorCode</code>).
 *
 * @see UBiDiLevel
 * @see UBiDiOrder
 * @see UBiDiMirroring
 * @see ubidi_setPara
 * @see u_shapeArabic
 * @stable ICU 58
 */
U_CAPI uint32_t U_EXPORT2
ubiditransform_transform(UBiDiTransform *pBiDiTransform,
            const UChar *src, int32_t srcLength,
            UChar *dest, int32_t destSize,
            UBiDiLevel inParaLevel, UBiDiOrder inOrder,
            UBiDiLevel outParaLevel, UBiDiOrder outOrder,
            UBiDiMirroring doMirroring, uint32_t shapingOptions,
            UErrorCode *pErrorCode);

/**
 * Allocates a <code>UBiDiTransform</code> object. This object can be reused,
 * e.g. with different ordering schemes, mirroring or shaping options.<p>
 * <strong>Note:</strong>The object can only be reused in the same thread.
 * All other threads should allocate a new <code>UBiDiTransform</code> object
 * before using it.<p>
 * Example of usage:<p>
 * <pre>
 * \code
 * UErrorCode errorCode = U_ZERO_ERROR;
 * // Open a new UBiDiTransform.
 * UBiDiTransform* transform = ubiditransform_open(&errorCode);
 * // Run a transformation.
 * ubiditransform_transform(transform,
 *          text1, -1, text2, -1,
 *          UBIDI_RTL, UBIDI_LOGICAL,
 *          UBIDI_LTR, UBIDI_VISUAL,
 *          UBIDI_MIRRORING_ON,
 *          U_SHAPE_DIGITS_EN2AN,
 *          &errorCode);
 * // Do something with the output text and invoke another transformation using
 * //   that text as input.
 * ubiditransform_transform(transform,
 *          text2, -1, text3, -1,
 *          UBIDI_LTR, UBIDI_VISUAL,
 *          UBIDI_RTL, UBIDI_VISUAL,
 *          UBIDI_MIRRORING_ON,
 *          0, &errorCode);
 *\endcode
 * </pre>
 * <p>
 * The <code>UBiDiTransform</code> object must be deallocated by calling
 * <code>ubiditransform_close()</code>.
 *
 * @return An empty <code>UBiDiTransform</code> object.
 * @stable ICU 58
 */
U_CAPI UBiDiTransform* U_EXPORT2
ubiditransform_open(UErrorCode *pErrorCode);

/**
 * Deallocates the given <code>UBiDiTransform</code> object.
 * @stable ICU 58
 */
U_CAPI void U_EXPORT2
ubiditransform_close(UBiDiTransform *pBidiTransform);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUBiDiTransformPointer
 * "Smart pointer" class, closes a UBiDiTransform via ubiditransform_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 58
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUBiDiTransformPointer, UBiDiTransform, ubiditransform_close);

U_NAMESPACE_END

#endif

#endif
