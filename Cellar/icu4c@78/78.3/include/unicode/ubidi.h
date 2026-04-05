// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*
*   Copyright (C) 1999-2013, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
******************************************************************************
*   file name:  ubidi.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 1999jul27
*   created by: Markus W. Scherer, updated by Matitiahu Allouche
*/

#ifndef UBIDI_H
#define UBIDI_H

#include "unicode/utypes.h"
#include "unicode/uchar.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 *\file
 * \brief C API: Bidi algorithm
 *
 * <h2>Bidi algorithm for ICU</h2>
 *
 * This is an implementation of the Unicode Bidirectional Algorithm.
 * The algorithm is defined in the
 * <a href="http://www.unicode.org/unicode/reports/tr9/">Unicode Standard Annex #9</a>.<p>
 *
 * Note: Libraries that perform a bidirectional algorithm and
 * reorder strings accordingly are sometimes called "Storage Layout Engines".
 * ICU's Bidi and shaping (u_shapeArabic()) APIs can be used at the core of such
 * "Storage Layout Engines".
 *
 * <h3>General remarks about the API:</h3>
 *
 * In functions with an error code parameter,
 * the <code>pErrorCode</code> pointer must be valid
 * and the value that it points to must not indicate a failure before
 * the function call. Otherwise, the function returns immediately.
 * After the function call, the value indicates success or failure.<p>
 *
 * The &quot;limit&quot; of a sequence of characters is the position just after their
 * last character, i.e., one more than that position.<p>
 *
 * Some of the API functions provide access to &quot;runs&quot;.
 * Such a &quot;run&quot; is defined as a sequence of characters
 * that are at the same embedding level
 * after performing the Bidi algorithm.<p>
 *
 * @author Markus W. Scherer
 * @version 1.0
 *
 *
 * <h4> Sample code for the ICU Bidi API </h4>
 *
 * <h5>Rendering a paragraph with the ICU Bidi API</h5>
 *
 * This is (hypothetical) sample code that illustrates
 * how the ICU Bidi API could be used to render a paragraph of text.
 * Rendering code depends highly on the graphics system,
 * therefore this sample code must make a lot of assumptions,
 * which may or may not match any existing graphics system's properties.
 *
 * <p>The basic assumptions are:</p>
 * <ul>
 * <li>Rendering is done from left to right on a horizontal line.</li>
 * <li>A run of single-style, unidirectional text can be rendered at once.</li>
 * <li>Such a run of text is passed to the graphics system with
 *     characters (code units) in logical order.</li>
 * <li>The line-breaking algorithm is very complicated
 *     and Locale-dependent -
 *     and therefore its implementation omitted from this sample code.</li>
 * </ul>
 *
 * <pre>
 * \code
 *#include <unicode/ubidi.h>
 *
 *typedef enum {
 *     styleNormal=0, styleSelected=1,
 *     styleBold=2, styleItalics=4,
 *     styleSuper=8, styleSub=16
 *} Style;
 *
 *typedef struct { int32_t limit; Style style; } StyleRun;
 *
 *int getTextWidth(const UChar *text, int32_t start, int32_t limit,
 *                  const StyleRun *styleRuns, int styleRunCount);
 *
 * // set *pLimit and *pStyleRunLimit for a line
 * // from text[start] and from styleRuns[styleRunStart]
 * // using ubidi_getLogicalRun(para, ...)
 *void getLineBreak(const UChar *text, int32_t start, int32_t *pLimit,
 *                  UBiDi *para,
 *                  const StyleRun *styleRuns, int styleRunStart, int *pStyleRunLimit,
 *                  int *pLineWidth);
 *
 * // render runs on a line sequentially, always from left to right
 *
 * // prepare rendering a new line
 * void startLine(UBiDiDirection textDirection, int lineWidth);
 *
 * // render a run of text and advance to the right by the run width
 * // the text[start..limit-1] is always in logical order
 * void renderRun(const UChar *text, int32_t start, int32_t limit,
 *               UBiDiDirection textDirection, Style style);
 *
 * // We could compute a cross-product
 * // from the style runs with the directional runs
 * // and then reorder it.
 * // Instead, here we iterate over each run type
 * // and render the intersections -
 * // with shortcuts in simple (and common) cases.
 * // renderParagraph() is the main function.
 *
 * // render a directional run with
 * // (possibly) multiple style runs intersecting with it
 * void renderDirectionalRun(const UChar *text,
 *                           int32_t start, int32_t limit,
 *                           UBiDiDirection direction,
 *                           const StyleRun *styleRuns, int styleRunCount) {
 *     int i;
 *
 *     // iterate over style runs
 *     if(direction==UBIDI_LTR) {
 *         int styleLimit;
 *
 *         for(i=0; i<styleRunCount; ++i) {
 *             styleLimit=styleRuns[i].limit;
 *             if(start<styleLimit) {
 *                 if(styleLimit>limit) { styleLimit=limit; }
 *                 renderRun(text, start, styleLimit,
 *                           direction, styleRuns[i].style);
 *                 if(styleLimit==limit) { break; }
 *                 start=styleLimit;
 *             }
 *         }
 *     } else {
 *         int styleStart;
 *
 *         for(i=styleRunCount-1; i>=0; --i) {
 *             if(i>0) {
 *                 styleStart=styleRuns[i-1].limit;
 *             } else {
 *                 styleStart=0;
 *             }
 *             if(limit>=styleStart) {
 *                 if(styleStart<start) { styleStart=start; }
 *                 renderRun(text, styleStart, limit,
 *                           direction, styleRuns[i].style);
 *                 if(styleStart==start) { break; }
 *                 limit=styleStart;
 *             }
 *         }
 *     }
 * }
 *
 * // the line object represents text[start..limit-1]
 * void renderLine(UBiDi *line, const UChar *text,
 *                 int32_t start, int32_t limit,
 *                 const StyleRun *styleRuns, int styleRunCount,
 *                 UErrorCode *pErrorCode) {
 *     UBiDiDirection direction=ubidi_getDirection(line);
 *     if(direction!=UBIDI_MIXED) {
 *         // unidirectional
 *         if(styleRunCount<=1) {
 *             renderRun(text, start, limit, direction, styleRuns[0].style);
 *         } else {
 *             renderDirectionalRun(text, start, limit,
 *                                  direction, styleRuns, styleRunCount);
 *         }
 *     } else {
 *         // mixed-directional
 *         int32_t count, i, length;
 *         UBiDiLevel level;
 *
 *         count=ubidi_countRuns(line, pErrorCode);
 *         if(U_SUCCESS(*pErrorCode)) {
 *             if(styleRunCount<=1) {
 *                 Style style=styleRuns[0].style;
 *
 *                 // iterate over directional runs
 *                for(i=0; i<count; ++i) {
 *                    direction=ubidi_getVisualRun(line, i, &start, &length);
 *                     renderRun(text, start, start+length, direction, style);
 *                }
 *             } else {
 *                 int32_t j;
 *
 *                 // iterate over both directional and style runs
 *                 for(i=0; i<count; ++i) {
 *                     direction=ubidi_getVisualRun(line, i, &start, &length);
 *                     renderDirectionalRun(text, start, start+length,
 *                                          direction, styleRuns, styleRunCount);
 *                 }
 *             }
 *         }
 *     }
 * }
 *
 *void renderParagraph(const UChar *text, int32_t length,
 *                     UBiDiDirection textDirection,
 *                      const StyleRun *styleRuns, int styleRunCount,
 *                      int lineWidth,
 *                      UErrorCode *pErrorCode) {
 *     UBiDi *para;
 *
 *     if(pErrorCode==NULL || U_FAILURE(*pErrorCode) || length<=0) {
 *         return;
 *     }
 *
 *     para=ubidi_openSized(length, 0, pErrorCode);
 *     if(para==NULL) { return; }
 *
 *     ubidi_setPara(para, text, length,
 *                   textDirection ? UBIDI_DEFAULT_RTL : UBIDI_DEFAULT_LTR,
 *                   NULL, pErrorCode);
 *     if(U_SUCCESS(*pErrorCode)) {
 *         UBiDiLevel paraLevel=1&ubidi_getParaLevel(para);
 *         StyleRun styleRun={ length, styleNormal };
 *         int width;
 *
 *         if(styleRuns==NULL || styleRunCount<=0) {
 *            styleRunCount=1;
 *             styleRuns=&styleRun;
 *         }
 *
 *        // assume styleRuns[styleRunCount-1].limit>=length
 *
 *         width=getTextWidth(text, 0, length, styleRuns, styleRunCount);
 *         if(width<=lineWidth) {
 *             // everything fits onto one line
 *
 *            // prepare rendering a new line from either left or right
 *             startLine(paraLevel, width);
 *
 *             renderLine(para, text, 0, length,
 *                        styleRuns, styleRunCount, pErrorCode);
 *         } else {
 *             UBiDi *line;
 *
 *             // we need to render several lines
 *             line=ubidi_openSized(length, 0, pErrorCode);
 *             if(line!=NULL) {
 *                 int32_t start=0, limit;
 *                 int styleRunStart=0, styleRunLimit;
 *
 *                 for(;;) {
 *                     limit=length;
 *                     styleRunLimit=styleRunCount;
 *                     getLineBreak(text, start, &limit, para,
 *                                  styleRuns, styleRunStart, &styleRunLimit,
 *                                 &width);
 *                     ubidi_setLine(para, start, limit, line, pErrorCode);
 *                     if(U_SUCCESS(*pErrorCode)) {
 *                         // prepare rendering a new line
 *                         // from either left or right
 *                         startLine(paraLevel, width);
 *
 *                         renderLine(line, text, start, limit,
 *                                    styleRuns+styleRunStart,
 *                                    styleRunLimit-styleRunStart, pErrorCode);
 *                     }
 *                     if(limit==length) { break; }
 *                     start=limit;
 *                     styleRunStart=styleRunLimit-1;
 *                     if(start>=styleRuns[styleRunStart].limit) {
 *                         ++styleRunStart;
 *                     }
 *                 }
 *
 *                 ubidi_close(line);
 *             }
 *        }
 *    }
 *
 *     ubidi_close(para);
 *}
 *\endcode
 * </pre>
 */

/*DOCXX_TAG*/
/*@{*/

/**
 * UBiDiLevel is the type of the level values in this
 * Bidi implementation.
 * It holds an embedding level and indicates the visual direction
 * by its bit&nbsp;0 (even/odd value).<p>
 *
 * It can also hold non-level values for the
 * <code>paraLevel</code> and <code>embeddingLevels</code>
 * arguments of <code>ubidi_setPara()</code>; there:
 * <ul>
 * <li>bit&nbsp;7 of an <code>embeddingLevels[]</code>
 * value indicates whether the using application is
 * specifying the level of a character to <i>override</i> whatever the
 * Bidi implementation would resolve it to.</li>
 * <li><code>paraLevel</code> can be set to the
 * pseudo-level values <code>UBIDI_DEFAULT_LTR</code>
 * and <code>UBIDI_DEFAULT_RTL</code>.</li>
 * </ul>
 *
 * @see ubidi_setPara
 *
 * <p>The related constants are not real, valid level values.
 * <code>UBIDI_DEFAULT_XXX</code> can be used to specify
 * a default for the paragraph level for
 * when the <code>ubidi_setPara()</code> function
 * shall determine it but there is no
 * strongly typed character in the input.<p>
 *
 * Note that the value for <code>UBIDI_DEFAULT_LTR</code> is even
 * and the one for <code>UBIDI_DEFAULT_RTL</code> is odd,
 * just like with normal LTR and RTL level values -
 * these special values are designed that way. Also, the implementation
 * assumes that UBIDI_MAX_EXPLICIT_LEVEL is odd.
 *
 * Note: The numeric values of the related constants will not change:
 * They are tied to the use of 7-bit byte values (plus the override bit)
 * and of the UBiDiLevel=uint8_t data type in this API.
 *
 * @see UBIDI_DEFAULT_LTR
 * @see UBIDI_DEFAULT_RTL
 * @see UBIDI_LEVEL_OVERRIDE
 * @see UBIDI_MAX_EXPLICIT_LEVEL
 * @stable ICU 2.0
 */
typedef uint8_t UBiDiLevel;

/** Paragraph level setting.<p>
 *
 * Constant indicating that the base direction depends on the first strong
 * directional character in the text according to the Unicode Bidirectional
 * Algorithm. If no strong directional character is present,
 * then set the paragraph level to 0 (left-to-right).<p>
 *
 * If this value is used in conjunction with reordering modes
 * <code>UBIDI_REORDER_INVERSE_LIKE_DIRECT</code> or
 * <code>UBIDI_REORDER_INVERSE_FOR_NUMBERS_SPECIAL</code>, the text to reorder
 * is assumed to be visual LTR, and the text after reordering is required
 * to be the corresponding logical string with appropriate contextual
 * direction. The direction of the result string will be RTL if either
 * the righmost or leftmost strong character of the source text is RTL
 * or Arabic Letter, the direction will be LTR otherwise.<p>
 *
 * If reordering option <code>UBIDI_OPTION_INSERT_MARKS</code> is set, an RLM may
 * be added at the beginning of the result string to ensure round trip
 * (that the result string, when reordered back to visual, will produce
 * the original source text).
 * @see UBIDI_REORDER_INVERSE_LIKE_DIRECT
 * @see UBIDI_REORDER_INVERSE_FOR_NUMBERS_SPECIAL
 * @stable ICU 2.0
 */
#define UBIDI_DEFAULT_LTR 0xfe

/** Paragraph level setting.<p>
 *
 * Constant indicating that the base direction depends on the first strong
 * directional character in the text according to the Unicode Bidirectional
 * Algorithm. If no strong directional character is present,
 * then set the paragraph level to 1 (right-to-left).<p>
 *
 * If this value is used in conjunction with reordering modes
 * <code>UBIDI_REORDER_INVERSE_LIKE_DIRECT</code> or
 * <code>UBIDI_REORDER_INVERSE_FOR_NUMBERS_SPECIAL</code>, the text to reorder
 * is assumed to be visual LTR, and the text after reordering is required
 * to be the corresponding logical string with appropriate contextual
 * direction. The direction of the result string will be RTL if either
 * the righmost or leftmost strong character of the source text is RTL
 * or Arabic Letter, or if the text contains no strong character;
 * the direction will be LTR otherwise.<p>
 *
 * If reordering option <code>UBIDI_OPTION_INSERT_MARKS</code> is set, an RLM may
 * be added at the beginning of the result string to ensure round trip
 * (that the result string, when reordered back to visual, will produce
 * the original source text).
 * @see UBIDI_REORDER_INVERSE_LIKE_DIRECT
 * @see UBIDI_REORDER_INVERSE_FOR_NUMBERS_SPECIAL
 * @stable ICU 2.0
 */
#define UBIDI_DEFAULT_RTL 0xff

/**
 * Maximum explicit embedding level.
 * Same as the max_depth value in the
 * <a href="http://www.unicode.org/reports/tr9/#BD2">Unicode Bidirectional Algorithm</a>.
 * (The maximum resolved level can be up to <code>UBIDI_MAX_EXPLICIT_LEVEL+1</code>).
 * @stable ICU 2.0
 */
#define UBIDI_MAX_EXPLICIT_LEVEL 125

/** Bit flag for level input.
 *  Overrides directional properties.
 * @stable ICU 2.0
 */
#define UBIDI_LEVEL_OVERRIDE 0x80

/**
 * Special value which can be returned by the mapping functions when a logical
 * index has no corresponding visual index or vice-versa. This may happen
 * for the logical-to-visual mapping of a Bidi control when option
 * <code>#UBIDI_OPTION_REMOVE_CONTROLS</code> is specified. This can also happen
 * for the visual-to-logical mapping of a Bidi mark (LRM or RLM) inserted
 * by option <code>#UBIDI_OPTION_INSERT_MARKS</code>.
 * @see ubidi_getVisualIndex
 * @see ubidi_getVisualMap
 * @see ubidi_getLogicalIndex
 * @see ubidi_getLogicalMap
 * @stable ICU 3.6
 */
#define UBIDI_MAP_NOWHERE   (-1)

/**
 * <code>UBiDiDirection</code> values indicate the text direction.
 * @stable ICU 2.0
 */
enum UBiDiDirection {
  /** Left-to-right text. This is a 0 value.
   * <ul>
   * <li>As return value for <code>ubidi_getDirection()</code>, it means
   *     that the source string contains no right-to-left characters, or
   *     that the source string is empty and the paragraph level is even.
   * <li> As return value for <code>ubidi_getBaseDirection()</code>, it
   *      means that the first strong character of the source string has
   *      a left-to-right direction.
   * </ul>
   * @stable ICU 2.0
   */
  UBIDI_LTR,
  /** Right-to-left text. This is a 1 value.
   * <ul>
   * <li>As return value for <code>ubidi_getDirection()</code>, it means
   *     that the source string contains no left-to-right characters, or
   *     that the source string is empty and the paragraph level is odd.
   * <li> As return value for <code>ubidi_getBaseDirection()</code>, it
   *      means that the first strong character of the source string has
   *      a right-to-left direction.
   * </ul>
   * @stable ICU 2.0
   */
  UBIDI_RTL,
  /** Mixed-directional text.
   * <p>As return value for <code>ubidi_getDirection()</code>, it means
   *    that the source string contains both left-to-right and
   *    right-to-left characters.
   * @stable ICU 2.0
   */
  UBIDI_MIXED,
  /** No strongly directional text.
   * <p>As return value for <code>ubidi_getBaseDirection()</code>, it means
   *    that the source string is missing or empty, or contains neither left-to-right
   *    nor right-to-left characters.
   * @stable ICU 4.6
   */
  UBIDI_NEUTRAL
};

/** @stable ICU 2.0 */
typedef enum UBiDiDirection UBiDiDirection;

/**
 * Forward declaration of the <code>UBiDi</code> structure for the declaration of
 * the API functions. Its fields are implementation-specific.<p>
 * This structure holds information about a paragraph (or multiple paragraphs)
 * of text with Bidi-algorithm-related details, or about one line of
 * such a paragraph.<p>
 * Reordering can be done on a line, or on one or more paragraphs which are
 * then interpreted each as one single line.
 * @stable ICU 2.0
 */
struct UBiDi;

/** @stable ICU 2.0 */
typedef struct UBiDi UBiDi;

/**
 * Allocate a <code>UBiDi</code> structure.
 * Such an object is initially empty. It is assigned
 * the Bidi properties of a piece of text containing one or more paragraphs
 * by <code>ubidi_setPara()</code>
 * or the Bidi properties of a line within a paragraph by
 * <code>ubidi_setLine()</code>.<p>
 * This object can be reused for as long as it is not deallocated
 * by calling <code>ubidi_close()</code>.<p>
 * <code>ubidi_setPara()</code> and <code>ubidi_setLine()</code> will allocate
 * additional memory for internal structures as necessary.
 *
 * @return An empty <code>UBiDi</code> object.
 * @stable ICU 2.0
 */
U_CAPI UBiDi * U_EXPORT2
ubidi_open(void);

/**
 * Allocate a <code>UBiDi</code> structure with preallocated memory
 * for internal structures.
 * This function provides a <code>UBiDi</code> object like <code>ubidi_open()</code>
 * with no arguments, but it also preallocates memory for internal structures
 * according to the sizings supplied by the caller.<p>
 * Subsequent functions will not allocate any more memory, and are thus
 * guaranteed not to fail because of lack of memory.<p>
 * The preallocation can be limited to some of the internal memory
 * by setting some values to 0 here. That means that if, e.g.,
 * <code>maxRunCount</code> cannot be reasonably predetermined and should not
 * be set to <code>maxLength</code> (the only failproof value) to avoid
 * wasting memory, then <code>maxRunCount</code> could be set to 0 here
 * and the internal structures that are associated with it will be allocated
 * on demand, just like with <code>ubidi_open()</code>.
 *
 * @param maxLength is the maximum text or line length that internal memory
 *        will be preallocated for. An attempt to associate this object with a
 *        longer text will fail, unless this value is 0, which leaves the allocation
 *        up to the implementation.
 *
 * @param maxRunCount is the maximum anticipated number of same-level runs
 *        that internal memory will be preallocated for. An attempt to access
 *        visual runs on an object that was not preallocated for as many runs
 *        as the text was actually resolved to will fail,
 *        unless this value is 0, which leaves the allocation up to the implementation.<br><br>
 *        The number of runs depends on the actual text and maybe anywhere between
 *        1 and <code>maxLength</code>. It is typically small.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @return An empty <code>UBiDi</code> object with preallocated memory.
 * @stable ICU 2.0
 */
U_CAPI UBiDi * U_EXPORT2
ubidi_openSized(int32_t maxLength, int32_t maxRunCount, UErrorCode *pErrorCode);

/**
 * <code>ubidi_close()</code> must be called to free the memory
 * associated with a UBiDi object.<p>
 *
 * <strong>Important: </strong>
 * A parent <code>UBiDi</code> object must not be destroyed or reused if
 * it still has children.
 * If a <code>UBiDi</code> object has become the <i>child</i>
 * of another one (its <i>parent</i>) by calling
 * <code>ubidi_setLine()</code>, then the child object must
 * be destroyed (closed) or reused (by calling
 * <code>ubidi_setPara()</code> or <code>ubidi_setLine()</code>)
 * before the parent object.
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 *
 * @see ubidi_setPara
 * @see ubidi_setLine
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_close(UBiDi *pBiDi);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUBiDiPointer
 * "Smart pointer" class, closes a UBiDi via ubidi_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUBiDiPointer, UBiDi, ubidi_close);

U_NAMESPACE_END

#endif

/**
 * Modify the operation of the Bidi algorithm such that it
 * approximates an "inverse Bidi" algorithm. This function
 * must be called before <code>ubidi_setPara()</code>.
 *
 * <p>The normal operation of the Bidi algorithm as described
 * in the Unicode Technical Report is to take text stored in logical
 * (keyboard, typing) order and to determine the reordering of it for visual
 * rendering.
 * Some legacy systems store text in visual order, and for operations
 * with standard, Unicode-based algorithms, the text needs to be transformed
 * to logical order. This is effectively the inverse algorithm of the
 * described Bidi algorithm. Note that there is no standard algorithm for
 * this "inverse Bidi" and that the current implementation provides only an
 * approximation of "inverse Bidi".</p>
 *
 * <p>With <code>isInverse</code> set to <code>true</code>,
 * this function changes the behavior of some of the subsequent functions
 * in a way that they can be used for the inverse Bidi algorithm.
 * Specifically, runs of text with numeric characters will be treated in a
 * special way and may need to be surrounded with LRM characters when they are
 * written in reordered sequence.</p>
 *
 * <p>Output runs should be retrieved using <code>ubidi_getVisualRun()</code>.
 * Since the actual input for "inverse Bidi" is visually ordered text and
 * <code>ubidi_getVisualRun()</code> gets the reordered runs, these are actually
 * the runs of the logically ordered output.</p>
 *
 * <p>Calling this function with argument <code>isInverse</code> set to
 * <code>true</code> is equivalent to calling
 * <code>ubidi_setReorderingMode</code> with argument
 * <code>reorderingMode</code>
 * set to <code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code>.<br>
 * Calling this function with argument <code>isInverse</code> set to
 * <code>false</code> is equivalent to calling
 * <code>ubidi_setReorderingMode</code> with argument
 * <code>reorderingMode</code>
 * set to <code>#UBIDI_REORDER_DEFAULT</code>.
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 *
 * @param isInverse specifies "forward" or "inverse" Bidi operation.
 *
 * @see ubidi_setPara
 * @see ubidi_writeReordered
 * @see ubidi_setReorderingMode
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_setInverse(UBiDi *pBiDi, UBool isInverse);

/**
 * Is this Bidi object set to perform the inverse Bidi algorithm?
 * <p>Note: calling this function after setting the reordering mode with
 * <code>ubidi_setReorderingMode</code> will return <code>true</code> if the
 * reordering mode was set to <code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code>,
 * <code>false</code> for all other values.</p>
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 * @return true if the Bidi object is set to perform the inverse Bidi algorithm
 * by handling numbers as L.
 *
 * @see ubidi_setInverse
 * @see ubidi_setReorderingMode
 * @stable ICU 2.0
 */

U_CAPI UBool U_EXPORT2
ubidi_isInverse(UBiDi *pBiDi);

/**
 * Specify whether block separators must be allocated level zero,
 * so that successive paragraphs will progress from left to right.
 * This function must be called before <code>ubidi_setPara()</code>.
 * Paragraph separators (B) may appear in the text.  Setting them to level zero
 * means that all paragraph separators (including one possibly appearing
 * in the last text position) are kept in the reordered text after the text
 * that they follow in the source text.
 * When this feature is not enabled, a paragraph separator at the last
 * position of the text before reordering will go to the first position
 * of the reordered text when the paragraph level is odd.
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 *
 * @param orderParagraphsLTR specifies whether paragraph separators (B) must
 * receive level 0, so that successive paragraphs progress from left to right.
 *
 * @see ubidi_setPara
 * @stable ICU 3.4
 */
U_CAPI void U_EXPORT2
ubidi_orderParagraphsLTR(UBiDi *pBiDi, UBool orderParagraphsLTR);

/**
 * Is this Bidi object set to allocate level 0 to block separators so that
 * successive paragraphs progress from left to right?
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 * @return true if the Bidi object is set to allocate level 0 to block
 *         separators.
 *
 * @see ubidi_orderParagraphsLTR
 * @stable ICU 3.4
 */
U_CAPI UBool U_EXPORT2
ubidi_isOrderParagraphsLTR(UBiDi *pBiDi);

/**
 * <code>UBiDiReorderingMode</code> values indicate which variant of the Bidi
 * algorithm to use.
 *
 * @see ubidi_setReorderingMode
 * @stable ICU 3.6
 */
typedef enum UBiDiReorderingMode {
    /** Regular Logical to Visual Bidi algorithm according to Unicode.
      * This is a 0 value.
      * @stable ICU 3.6 */
    UBIDI_REORDER_DEFAULT = 0,
    /** Logical to Visual algorithm which handles numbers in a way which
      * mimics the behavior of Windows XP.
      * @stable ICU 3.6 */
    UBIDI_REORDER_NUMBERS_SPECIAL,
    /** Logical to Visual algorithm grouping numbers with adjacent R characters
      * (reversible algorithm).
      * @stable ICU 3.6 */
    UBIDI_REORDER_GROUP_NUMBERS_WITH_R,
    /** Reorder runs only to transform a Logical LTR string to the Logical RTL
      * string with the same display, or vice-versa.<br>
      * If this mode is set together with option
      * <code>#UBIDI_OPTION_INSERT_MARKS</code>, some Bidi controls in the source
      * text may be removed and other controls may be added to produce the
      * minimum combination which has the required display.
      * @stable ICU 3.6 */
    UBIDI_REORDER_RUNS_ONLY,
    /** Visual to Logical algorithm which handles numbers like L
      * (same algorithm as selected by <code>ubidi_setInverse(true)</code>.
      * @see ubidi_setInverse
      * @stable ICU 3.6 */
    UBIDI_REORDER_INVERSE_NUMBERS_AS_L,
    /** Visual to Logical algorithm equivalent to the regular Logical to Visual
      * algorithm.
      * @stable ICU 3.6 */
    UBIDI_REORDER_INVERSE_LIKE_DIRECT,
    /** Inverse Bidi (Visual to Logical) algorithm for the
      * <code>UBIDI_REORDER_NUMBERS_SPECIAL</code> Bidi algorithm.
      * @stable ICU 3.6 */
    UBIDI_REORDER_INVERSE_FOR_NUMBERS_SPECIAL,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * Number of values for reordering mode.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UBIDI_REORDER_COUNT
#endif  // U_HIDE_DEPRECATED_API
} UBiDiReorderingMode;

/**
 * Modify the operation of the Bidi algorithm such that it implements some
 * variant to the basic Bidi algorithm or approximates an "inverse Bidi"
 * algorithm, depending on different values of the "reordering mode".
 * This function must be called before <code>ubidi_setPara()</code>, and stays
 * in effect until called again with a different argument.
 *
 * <p>The normal operation of the Bidi algorithm as described
 * in the Unicode Standard Annex #9 is to take text stored in logical
 * (keyboard, typing) order and to determine how to reorder it for visual
 * rendering.</p>
 *
 * <p>With the reordering mode set to a value other than
 * <code>#UBIDI_REORDER_DEFAULT</code>, this function changes the behavior of
 * some of the subsequent functions in a way such that they implement an
 * inverse Bidi algorithm or some other algorithm variants.</p>
 *
 * <p>Some legacy systems store text in visual order, and for operations
 * with standard, Unicode-based algorithms, the text needs to be transformed
 * into logical order. This is effectively the inverse algorithm of the
 * described Bidi algorithm. Note that there is no standard algorithm for
 * this "inverse Bidi", so a number of variants are implemented here.</p>
 *
 * <p>In other cases, it may be desirable to emulate some variant of the
 * Logical to Visual algorithm (e.g. one used in MS Windows), or perform a
 * Logical to Logical transformation.</p>
 *
 * <ul>
 * <li>When the reordering mode is set to <code>#UBIDI_REORDER_DEFAULT</code>,
 * the standard Bidi Logical to Visual algorithm is applied.</li>
 *
 * <li>When the reordering mode is set to
 * <code>#UBIDI_REORDER_NUMBERS_SPECIAL</code>,
 * the algorithm used to perform Bidi transformations when calling
 * <code>ubidi_setPara</code> should approximate the algorithm used in
 * Microsoft Windows XP rather than strictly conform to the Unicode Bidi
 * algorithm.
 * <br>
 * The differences between the basic algorithm and the algorithm addressed
 * by this option are as follows:
 * <ul>
 *   <li>Within text at an even embedding level, the sequence "123AB"
 *   (where AB represent R or AL letters) is transformed to "123BA" by the
 *   Unicode algorithm and to "BA123" by the Windows algorithm.</li>
 *   <li>Arabic-Indic numbers (AN) are handled by the Windows algorithm just
 *   like regular numbers (EN).</li>
 * </ul></li>
 *
 * <li>When the reordering mode is set to
 * <code>#UBIDI_REORDER_GROUP_NUMBERS_WITH_R</code>,
 * numbers located between LTR text and RTL text are associated with the RTL
 * text. For instance, an LTR paragraph with content "abc 123 DEF" (where
 * upper case letters represent RTL characters) will be transformed to
 * "abc FED 123" (and not "abc 123 FED"), "DEF 123 abc" will be transformed
 * to "123 FED abc" and "123 FED abc" will be transformed to "DEF 123 abc".
 * This makes the algorithm reversible and makes it useful when round trip
 * (from visual to logical and back to visual) must be achieved without
 * adding LRM characters. However, this is a variation from the standard
 * Unicode Bidi algorithm.<br>
 * The source text should not contain Bidi control characters other than LRM
 * or RLM.</li>
 *
 * <li>When the reordering mode is set to
 * <code>#UBIDI_REORDER_RUNS_ONLY</code>,
 * a "Logical to Logical" transformation must be performed:
 * <ul>
 * <li>If the default text level of the source text (argument <code>paraLevel</code>
 * in <code>ubidi_setPara</code>) is even, the source text will be handled as
 * LTR logical text and will be transformed to the RTL logical text which has
 * the same LTR visual display.</li>
 * <li>If the default level of the source text is odd, the source text
 * will be handled as RTL logical text and will be transformed to the
 * LTR logical text which has the same LTR visual display.</li>
 * </ul>
 * This mode may be needed when logical text which is basically Arabic or
 * Hebrew, with possible included numbers or phrases in English, has to be
 * displayed as if it had an even embedding level (this can happen if the
 * displaying application treats all text as if it was basically LTR).
 * <br>
 * This mode may also be needed in the reverse case, when logical text which is
 * basically English, with possible included phrases in Arabic or Hebrew, has to
 * be displayed as if it had an odd embedding level.
 * <br>
 * Both cases could be handled by adding LRE or RLE at the head of the text,
 * if the display subsystem supports these formatting controls. If it does not,
 * the problem may be handled by transforming the source text in this mode
 * before displaying it, so that it will be displayed properly.<br>
 * The source text should not contain Bidi control characters other than LRM
 * or RLM.</li>
 *
 * <li>When the reordering mode is set to
 * <code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code>, an "inverse Bidi" algorithm
 * is applied.
 * Runs of text with numeric characters will be treated like LTR letters and
 * may need to be surrounded with LRM characters when they are written in
 * reordered sequence (the option <code>#UBIDI_INSERT_LRM_FOR_NUMERIC</code> can
 * be used with function <code>ubidi_writeReordered</code> to this end. This
 * mode is equivalent to calling <code>ubidi_setInverse()</code> with
 * argument <code>isInverse</code> set to <code>true</code>.</li>
 *
 * <li>When the reordering mode is set to
 * <code>#UBIDI_REORDER_INVERSE_LIKE_DIRECT</code>, the "direct" Logical to Visual
 * Bidi algorithm is used as an approximation of an "inverse Bidi" algorithm.
 * This mode is similar to mode <code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code>
 * but is closer to the regular Bidi algorithm.
 * <br>
 * For example, an LTR paragraph with the content "FED 123 456 CBA" (where
 * upper case represents RTL characters) will be transformed to
 * "ABC 456 123 DEF", as opposed to "DEF 123 456 ABC"
 * with mode <code>UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code>.<br>
 * When used in conjunction with option
 * <code>#UBIDI_OPTION_INSERT_MARKS</code>, this mode generally
 * adds Bidi marks to the output significantly more sparingly than mode
 * <code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code> with option
 * <code>#UBIDI_INSERT_LRM_FOR_NUMERIC</code> in calls to
 * <code>ubidi_writeReordered</code>.</li>
 *
 * <li>When the reordering mode is set to
 * <code>#UBIDI_REORDER_INVERSE_FOR_NUMBERS_SPECIAL</code>, the Logical to Visual
 * Bidi algorithm used in Windows XP is used as an approximation of an "inverse Bidi" algorithm.
 * <br>
 * For example, an LTR paragraph with the content "abc FED123" (where
 * upper case represents RTL characters) will be transformed to "abc 123DEF."</li>
 * </ul>
 *
 * <p>In all the reordering modes specifying an "inverse Bidi" algorithm
 * (i.e. those with a name starting with <code>UBIDI_REORDER_INVERSE</code>),
 * output runs should be retrieved using
 * <code>ubidi_getVisualRun()</code>, and the output text with
 * <code>ubidi_writeReordered()</code>. The caller should keep in mind that in
 * "inverse Bidi" modes the input is actually visually ordered text and
 * reordered output returned by <code>ubidi_getVisualRun()</code> or
 * <code>ubidi_writeReordered()</code> are actually runs or character string
 * of logically ordered output.<br>
 * For all the "inverse Bidi" modes, the source text should not contain
 * Bidi control characters other than LRM or RLM.</p>
 *
 * <p>Note that option <code>#UBIDI_OUTPUT_REVERSE</code> of
 * <code>ubidi_writeReordered</code> has no useful meaning and should not be
 * used in conjunction with any value of the reordering mode specifying
 * "inverse Bidi" or with value <code>UBIDI_REORDER_RUNS_ONLY</code>.
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 * @param reorderingMode specifies the required variant of the Bidi algorithm.
 *
 * @see UBiDiReorderingMode
 * @see ubidi_setInverse
 * @see ubidi_setPara
 * @see ubidi_writeReordered
 * @stable ICU 3.6
 */
U_CAPI void U_EXPORT2
ubidi_setReorderingMode(UBiDi *pBiDi, UBiDiReorderingMode reorderingMode);

/**
 * What is the requested reordering mode for a given Bidi object?
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 * @return the current reordering mode of the Bidi object
 * @see ubidi_setReorderingMode
 * @stable ICU 3.6
 */
U_CAPI UBiDiReorderingMode U_EXPORT2
ubidi_getReorderingMode(UBiDi *pBiDi);

/**
 * <code>UBiDiReorderingOption</code> values indicate which options are
 * specified to affect the Bidi algorithm.
 *
 * @see ubidi_setReorderingOptions
 * @stable ICU 3.6
 */
typedef enum UBiDiReorderingOption {
    /**
     * option value for <code>ubidi_setReorderingOptions</code>:
     * disable all the options which can be set with this function
     * @see ubidi_setReorderingOptions
     * @stable ICU 3.6
     */
    UBIDI_OPTION_DEFAULT = 0,

    /**
     * option bit for <code>ubidi_setReorderingOptions</code>:
     * insert Bidi marks (LRM or RLM) when needed to ensure correct result of
     * a reordering to a Logical order
     *
     * <p>This option must be set or reset before calling
     * <code>ubidi_setPara</code>.</p>
     *
     * <p>This option is significant only with reordering modes which generate
     * a result with Logical order, specifically:</p>
     * <ul>
     *   <li><code>#UBIDI_REORDER_RUNS_ONLY</code></li>
     *   <li><code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code></li>
     *   <li><code>#UBIDI_REORDER_INVERSE_LIKE_DIRECT</code></li>
     *   <li><code>#UBIDI_REORDER_INVERSE_FOR_NUMBERS_SPECIAL</code></li>
     * </ul>
     *
     * <p>If this option is set in conjunction with reordering mode
     * <code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code> or with calling
     * <code>ubidi_setInverse(true)</code>, it implies
     * option <code>#UBIDI_INSERT_LRM_FOR_NUMERIC</code>
     * in calls to function <code>ubidi_writeReordered()</code>.</p>
     *
     * <p>For other reordering modes, a minimum number of LRM or RLM characters
     * will be added to the source text after reordering it so as to ensure
     * round trip, i.e. when applying the inverse reordering mode on the
     * resulting logical text with removal of Bidi marks
     * (option <code>#UBIDI_OPTION_REMOVE_CONTROLS</code> set before calling
     * <code>ubidi_setPara()</code> or option <code>#UBIDI_REMOVE_BIDI_CONTROLS</code>
     * in <code>ubidi_writeReordered</code>), the result will be identical to the
     * source text in the first transformation.
     *
     * <p>This option will be ignored if specified together with option
     * <code>#UBIDI_OPTION_REMOVE_CONTROLS</code>. It inhibits option
     * <code>UBIDI_REMOVE_BIDI_CONTROLS</code> in calls to function
     * <code>ubidi_writeReordered()</code> and it implies option
     * <code>#UBIDI_INSERT_LRM_FOR_NUMERIC</code> in calls to function
     * <code>ubidi_writeReordered()</code> if the reordering mode is
     * <code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code>.</p>
     *
     * @see ubidi_setReorderingMode
     * @see ubidi_setReorderingOptions
     * @stable ICU 3.6
     */
    UBIDI_OPTION_INSERT_MARKS = 1,

    /**
     * option bit for <code>ubidi_setReorderingOptions</code>:
     * remove Bidi control characters
     *
     * <p>This option must be set or reset before calling
     * <code>ubidi_setPara</code>.</p>
     *
     * <p>This option nullifies option <code>#UBIDI_OPTION_INSERT_MARKS</code>.
     * It inhibits option <code>#UBIDI_INSERT_LRM_FOR_NUMERIC</code> in calls
     * to function <code>ubidi_writeReordered()</code> and it implies option
     * <code>#UBIDI_REMOVE_BIDI_CONTROLS</code> in calls to that function.</p>
     *
     * @see ubidi_setReorderingMode
     * @see ubidi_setReorderingOptions
     * @stable ICU 3.6
     */
    UBIDI_OPTION_REMOVE_CONTROLS = 2,

    /**
     * option bit for <code>ubidi_setReorderingOptions</code>:
     * process the output as part of a stream to be continued
     *
     * <p>This option must be set or reset before calling
     * <code>ubidi_setPara</code>.</p>
     *
     * <p>This option specifies that the caller is interested in processing large
     * text object in parts.
     * The results of the successive calls are expected to be concatenated by the
     * caller. Only the call for the last part will have this option bit off.</p>
     *
     * <p>When this option bit is on, <code>ubidi_setPara()</code> may process
     * less than the full source text in order to truncate the text at a meaningful
     * boundary. The caller should call <code>ubidi_getProcessedLength()</code>
     * immediately after calling <code>ubidi_setPara()</code> in order to
     * determine how much of the source text has been processed.
     * Source text beyond that length should be resubmitted in following calls to
     * <code>ubidi_setPara</code>. The processed length may be less than
     * the length of the source text if a character preceding the last character of
     * the source text constitutes a reasonable boundary (like a block separator)
     * for text to be continued.<br>
     * If the last character of the source text constitutes a reasonable
     * boundary, the whole text will be processed at once.<br>
     * If nowhere in the source text there exists
     * such a reasonable boundary, the processed length will be zero.<br>
     * The caller should check for such an occurrence and do one of the following:
     * <ul><li>submit a larger amount of text with a better chance to include
     *         a reasonable boundary.</li>
     *     <li>resubmit the same text after turning off option
     *         <code>UBIDI_OPTION_STREAMING</code>.</li></ul>
     * In all cases, this option should be turned off before processing the last
     * part of the text.</p>
     *
     * <p>When the <code>UBIDI_OPTION_STREAMING</code> option is used,
     * it is recommended to call <code>ubidi_orderParagraphsLTR()</code> with
     * argument <code>orderParagraphsLTR</code> set to <code>true</code> before
     * calling <code>ubidi_setPara</code> so that later paragraphs may be
     * concatenated to previous paragraphs on the right.</p>
     *
     * @see ubidi_setReorderingMode
     * @see ubidi_setReorderingOptions
     * @see ubidi_getProcessedLength
     * @see ubidi_orderParagraphsLTR
     * @stable ICU 3.6
     */
    UBIDI_OPTION_STREAMING = 4
} UBiDiReorderingOption;

/**
 * Specify which of the reordering options
 * should be applied during Bidi transformations.
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 * @param reorderingOptions is a combination of zero or more of the following
 * options:
 * <code>#UBIDI_OPTION_DEFAULT</code>, <code>#UBIDI_OPTION_INSERT_MARKS</code>,
 * <code>#UBIDI_OPTION_REMOVE_CONTROLS</code>, <code>#UBIDI_OPTION_STREAMING</code>.
 *
 * @see ubidi_getReorderingOptions
 * @stable ICU 3.6
 */
U_CAPI void U_EXPORT2
ubidi_setReorderingOptions(UBiDi *pBiDi, uint32_t reorderingOptions);

/**
 * What are the reordering options applied to a given Bidi object?
 *
 * @param pBiDi is a <code>UBiDi</code> object.
 * @return the current reordering options of the Bidi object
 * @see ubidi_setReorderingOptions
 * @stable ICU 3.6
 */
U_CAPI uint32_t U_EXPORT2
ubidi_getReorderingOptions(UBiDi *pBiDi);

/**
 * Set the context before a call to ubidi_setPara().<p>
 *
 * ubidi_setPara() computes the left-right directionality for a given piece
 * of text which is supplied as one of its arguments. Sometimes this piece
 * of text (the "main text") should be considered in context, because text
 * appearing before ("prologue") and/or after ("epilogue") the main text
 * may affect the result of this computation.<p>
 *
 * This function specifies the prologue and/or the epilogue for the next
 * call to ubidi_setPara(). The characters specified as prologue and
 * epilogue should not be modified by the calling program until the call
 * to ubidi_setPara() has returned. If successive calls to ubidi_setPara()
 * all need specification of a context, ubidi_setContext() must be called
 * before each call to ubidi_setPara(). In other words, a context is not
 * "remembered" after the following successful call to ubidi_setPara().<p>
 *
 * If a call to ubidi_setPara() specifies UBIDI_DEFAULT_LTR or
 * UBIDI_DEFAULT_RTL as paraLevel and is preceded by a call to
 * ubidi_setContext() which specifies a prologue, the paragraph level will
 * be computed taking in consideration the text in the prologue.<p>
 *
 * When ubidi_setPara() is called without a previous call to
 * ubidi_setContext, the main text is handled as if preceded and followed
 * by strong directional characters at the current paragraph level.
 * Calling ubidi_setContext() with specification of a prologue will change
 * this behavior by handling the main text as if preceded by the last
 * strong character appearing in the prologue, if any.
 * Calling ubidi_setContext() with specification of an epilogue will change
 * the behavior of ubidi_setPara() by handling the main text as if followed
 * by the first strong character or digit appearing in the epilogue, if any.<p>
 *
 * Note 1: if <code>ubidi_setContext</code> is called repeatedly without
 *         calling <code>ubidi_setPara</code>, the earlier calls have no effect,
 *         only the last call will be remembered for the next call to
 *         <code>ubidi_setPara</code>.<p>
 *
 * Note 2: calling <code>ubidi_setContext(pBiDi, NULL, 0, NULL, 0, &errorCode)</code>
 *         cancels any previous setting of non-empty prologue or epilogue.
 *         The next call to <code>ubidi_setPara()</code> will process no
 *         prologue or epilogue.<p>
 *
 * Note 3: users must be aware that even after setting the context
 *         before a call to ubidi_setPara() to perform e.g. a logical to visual
 *         transformation, the resulting string may not be identical to what it
 *         would have been if all the text, including prologue and epilogue, had
 *         been processed together.<br>
 * Example (upper case letters represent RTL characters):<br>
 * &nbsp;&nbsp;prologue = "<code>abc DE</code>"<br>
 * &nbsp;&nbsp;epilogue = none<br>
 * &nbsp;&nbsp;main text = "<code>FGH xyz</code>"<br>
 * &nbsp;&nbsp;paraLevel = UBIDI_LTR<br>
 * &nbsp;&nbsp;display without prologue = "<code>HGF xyz</code>"
 *             ("HGF" is adjacent to "xyz")<br>
 * &nbsp;&nbsp;display with prologue = "<code>abc HGFED xyz</code>"
 *             ("HGF" is not adjacent to "xyz")<br>
 *
 * @param pBiDi is a paragraph <code>UBiDi</code> object.
 *
 * @param prologue is a pointer to the text which precedes the text that
 *        will be specified in a coming call to ubidi_setPara().
 *        If there is no prologue to consider, then <code>proLength</code>
 *        must be zero and this pointer can be NULL.
 *
 * @param proLength is the length of the prologue; if <code>proLength==-1</code>
 *        then the prologue must be zero-terminated.
 *        Otherwise proLength must be >= 0. If <code>proLength==0</code>, it means
 *        that there is no prologue to consider.
 *
 * @param epilogue is a pointer to the text which follows the text that
 *        will be specified in a coming call to ubidi_setPara().
 *        If there is no epilogue to consider, then <code>epiLength</code>
 *        must be zero and this pointer can be NULL.
 *
 * @param epiLength is the length of the epilogue; if <code>epiLength==-1</code>
 *        then the epilogue must be zero-terminated.
 *        Otherwise epiLength must be >= 0. If <code>epiLength==0</code>, it means
 *        that there is no epilogue to consider.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @see ubidi_setPara
 * @stable ICU 4.8
 */
U_CAPI void U_EXPORT2
ubidi_setContext(UBiDi *pBiDi,
                 const UChar *prologue, int32_t proLength,
                 const UChar *epilogue, int32_t epiLength,
                 UErrorCode *pErrorCode);

/**
 * Perform the Unicode Bidi algorithm. It is defined in the
 * <a href="http://www.unicode.org/unicode/reports/tr9/">Unicode Standard Annex #9</a>,
 * version 13,
 * also described in The Unicode Standard, Version 4.0 .<p>
 *
 * This function takes a piece of plain text containing one or more paragraphs,
 * with or without externally specified embedding levels from <i>styled</i>
 * text and computes the left-right-directionality of each character.<p>
 *
 * If the entire text is all of the same directionality, then
 * the function may not perform all the steps described by the algorithm,
 * i.e., some levels may not be the same as if all steps were performed.
 * This is not relevant for unidirectional text.<br>
 * For example, in pure LTR text with numbers the numbers would get
 * a resolved level of 2 higher than the surrounding text according to
 * the algorithm. This implementation may set all resolved levels to
 * the same value in such a case.<p>
 *
 * The text can be composed of multiple paragraphs. Occurrence of a block
 * separator in the text terminates a paragraph, and whatever comes next starts
 * a new paragraph. The exception to this rule is when a Carriage Return (CR)
 * is followed by a Line Feed (LF). Both CR and LF are block separators, but
 * in that case, the pair of characters is considered as terminating the
 * preceding paragraph, and a new paragraph will be started by a character
 * coming after the LF.
 *
 * @param pBiDi A <code>UBiDi</code> object allocated with <code>ubidi_open()</code>
 *        which will be set to contain the reordering information,
 *        especially the resolved levels for all the characters in <code>text</code>.
 *
 * @param text is a pointer to the text that the Bidi algorithm will be performed on.
 *        This pointer is stored in the UBiDi object and can be retrieved
 *        with <code>ubidi_getText()</code>.<br>
 *        <strong>Note:</strong> the text must be (at least) <code>length</code> long.
 *
 * @param length is the length of the text; if <code>length==-1</code> then
 *        the text must be zero-terminated.
 *
 * @param paraLevel specifies the default level for the text;
 *        it is typically 0 (LTR) or 1 (RTL).
 *        If the function shall determine the paragraph level from the text,
 *        then <code>paraLevel</code> can be set to
 *        either <code>#UBIDI_DEFAULT_LTR</code>
 *        or <code>#UBIDI_DEFAULT_RTL</code>; if the text contains multiple
 *        paragraphs, the paragraph level shall be determined separately for
 *        each paragraph; if a paragraph does not include any strongly typed
 *        character, then the desired default is used (0 for LTR or 1 for RTL).
 *        Any other value between 0 and <code>#UBIDI_MAX_EXPLICIT_LEVEL</code>
 *        is also valid, with odd levels indicating RTL.
 *
 * @param embeddingLevels (in) may be used to preset the embedding and override levels,
 *        ignoring characters like LRE and PDF in the text.
 *        A level overrides the directional property of its corresponding
 *        (same index) character if the level has the
 *        <code>#UBIDI_LEVEL_OVERRIDE</code> bit set.<br><br>
 *        Aside from that bit, it must be
 *        <code>paraLevel<=embeddingLevels[]<=UBIDI_MAX_EXPLICIT_LEVEL</code>,
 *        except that level 0 is always allowed.
 *        Level 0 for a paragraph separator prevents reordering of paragraphs;
 *        this only works reliably if <code>#UBIDI_LEVEL_OVERRIDE</code>
 *        is also set for paragraph separators.
 *        Level 0 for other characters is treated as a wildcard
 *        and is lifted up to the resolved level of the surrounding paragraph.<br><br>
 *        <strong>Caution: </strong>A copy of this pointer, not of the levels,
 *        will be stored in the <code>UBiDi</code> object;
 *        the <code>embeddingLevels</code> array must not be
 *        deallocated before the <code>UBiDi</code> structure is destroyed or reused,
 *        and the <code>embeddingLevels</code>
 *        should not be modified to avoid unexpected results on subsequent Bidi operations.
 *        However, the <code>ubidi_setPara()</code> and
 *        <code>ubidi_setLine()</code> functions may modify some or all of the levels.<br><br>
 *        After the <code>UBiDi</code> object is reused or destroyed, the caller
 *        must take care of the deallocation of the <code>embeddingLevels</code> array.<br><br>
 *        <strong>Note:</strong> the <code>embeddingLevels</code> array must be
 *        at least <code>length</code> long.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_setPara(UBiDi *pBiDi, const UChar *text, int32_t length,
              UBiDiLevel paraLevel, UBiDiLevel *embeddingLevels,
              UErrorCode *pErrorCode);

/**
 * <code>ubidi_setLine()</code> sets a <code>UBiDi</code> to
 * contain the reordering information, especially the resolved levels,
 * for all the characters in a line of text. This line of text is
 * specified by referring to a <code>UBiDi</code> object representing
 * this information for a piece of text containing one or more paragraphs,
 * and by specifying a range of indexes in this text.<p>
 * In the new line object, the indexes will range from 0 to <code>limit-start-1</code>.<p>
 *
 * This is used after calling <code>ubidi_setPara()</code>
 * for a piece of text, and after line-breaking on that text.
 * It is not necessary if each paragraph is treated as a single line.<p>
 *
 * After line-breaking, rules (L1) and (L2) for the treatment of
 * trailing WS and for reordering are performed on
 * a <code>UBiDi</code> object that represents a line.<p>
 *
 * <strong>Important: </strong><code>pLineBiDi</code> shares data with
 * <code>pParaBiDi</code>.
 * You must destroy or reuse <code>pLineBiDi</code> before <code>pParaBiDi</code>.
 * In other words, you must destroy or reuse the <code>UBiDi</code> object for a line
 * before the object for its parent paragraph.<p>
 *
 * The text pointer that was stored in <code>pParaBiDi</code> is also copied,
 * and <code>start</code> is added to it so that it points to the beginning of the
 * line for this object.
 *
 * @param pParaBiDi is the parent paragraph object. It must have been set
 * by a successful call to ubidi_setPara.
 *
 * @param start is the line's first index into the text.
 *
 * @param limit is just behind the line's last index into the text
 *        (its last index +1).<br>
 *        It must be <code>0<=start<limit<=</code>containing paragraph limit.
 *        If the specified line crosses a paragraph boundary, the function
 *        will terminate with error code U_ILLEGAL_ARGUMENT_ERROR.
 *
 * @param pLineBiDi is the object that will now represent a line of the text.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @see ubidi_setPara
 * @see ubidi_getProcessedLength
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_setLine(const UBiDi *pParaBiDi,
              int32_t start, int32_t limit,
              UBiDi *pLineBiDi,
              UErrorCode *pErrorCode);

/**
 * Get the directionality of the text.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @return a value of <code>UBIDI_LTR</code>, <code>UBIDI_RTL</code>
 *         or <code>UBIDI_MIXED</code>
 *         that indicates if the entire text
 *         represented by this object is unidirectional,
 *         and which direction, or if it is mixed-directional.
 * Note -  The value <code>UBIDI_NEUTRAL</code> is never returned from this method.
 *
 * @see UBiDiDirection
 * @stable ICU 2.0
 */
U_CAPI UBiDiDirection U_EXPORT2
ubidi_getDirection(const UBiDi *pBiDi);

/**
 * Gets the base direction of the text provided according
 * to the Unicode Bidirectional Algorithm. The base direction
 * is derived from the first character in the string with bidirectional
 * character type L, R, or AL. If the first such character has type L,
 * <code>UBIDI_LTR</code> is returned. If the first such character has
 * type R or AL, <code>UBIDI_RTL</code> is returned. If the string does
 * not contain any character of these types, then
 * <code>UBIDI_NEUTRAL</code> is returned.
 *
 * This is a lightweight function for use when only the base direction
 * is needed and no further bidi processing of the text is needed.
 *
 * @param text is a pointer to the text whose base
 *             direction is needed.
 * Note: the text must be (at least) @c length long.
 *
 * @param length is the length of the text;
 *               if <code>length==-1</code> then the text
 *               must be zero-terminated.
 *
 * @return  <code>UBIDI_LTR</code>, <code>UBIDI_RTL</code>,
 *          <code>UBIDI_NEUTRAL</code>
 *
 * @see UBiDiDirection
 * @stable ICU 4.6
 */
U_CAPI UBiDiDirection U_EXPORT2
ubidi_getBaseDirection(const UChar *text,  int32_t length );

/**
 * Get the pointer to the text.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @return The pointer to the text that the UBiDi object was created for.
 *
 * @see ubidi_setPara
 * @see ubidi_setLine
 * @stable ICU 2.0
 */
U_CAPI const UChar * U_EXPORT2
ubidi_getText(const UBiDi *pBiDi);

/**
 * Get the length of the text.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @return The length of the text that the UBiDi object was created for.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubidi_getLength(const UBiDi *pBiDi);

/**
 * Get the paragraph level of the text.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @return The paragraph level. If there are multiple paragraphs, their
 *         level may vary if the required paraLevel is UBIDI_DEFAULT_LTR or
 *         UBIDI_DEFAULT_RTL.  In that case, the level of the first paragraph
 *         is returned.
 *
 * @see UBiDiLevel
 * @see ubidi_getParagraph
 * @see ubidi_getParagraphByIndex
 * @stable ICU 2.0
 */
U_CAPI UBiDiLevel U_EXPORT2
ubidi_getParaLevel(const UBiDi *pBiDi);

/**
 * Get the number of paragraphs.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @return The number of paragraphs.
 * @stable ICU 3.4
 */
U_CAPI int32_t U_EXPORT2
ubidi_countParagraphs(UBiDi *pBiDi);

/**
 * Get a paragraph, given a position within the text.
 * This function returns information about a paragraph.<br>
 * Note: if the paragraph index is known, it is more efficient to
 * retrieve the paragraph information using ubidi_getParagraphByIndex().<p>
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param charIndex is the index of a character within the text, in the
 *        range <code>[0..ubidi_getProcessedLength(pBiDi)-1]</code>.
 *
 * @param pParaStart will receive the index of the first character of the
 *        paragraph in the text.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @param pParaLimit will receive the limit of the paragraph.
 *        The l-value that you point to here may be the
 *        same expression (variable) as the one for
 *        <code>charIndex</code>.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @param pParaLevel will receive the level of the paragraph.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @return The index of the paragraph containing the specified position.
 *
 * @see ubidi_getProcessedLength
 * @stable ICU 3.4
 */
U_CAPI int32_t U_EXPORT2
ubidi_getParagraph(const UBiDi *pBiDi, int32_t charIndex, int32_t *pParaStart,
                   int32_t *pParaLimit, UBiDiLevel *pParaLevel,
                   UErrorCode *pErrorCode);

/**
 * Get a paragraph, given the index of this paragraph.
 *
 * This function returns information about a paragraph.<p>
 *
 * @param pBiDi is the paragraph <code>UBiDi</code> object.
 *
 * @param paraIndex is the number of the paragraph, in the
 *        range <code>[0..ubidi_countParagraphs(pBiDi)-1]</code>.
 *
 * @param pParaStart will receive the index of the first character of the
 *        paragraph in the text.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @param pParaLimit will receive the limit of the paragraph.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @param pParaLevel will receive the level of the paragraph.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @stable ICU 3.4
 */
U_CAPI void U_EXPORT2
ubidi_getParagraphByIndex(const UBiDi *pBiDi, int32_t paraIndex,
                          int32_t *pParaStart, int32_t *pParaLimit,
                          UBiDiLevel *pParaLevel, UErrorCode *pErrorCode);

/**
 * Get the level for one character.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param charIndex the index of a character. It must be in the range
 *         [0..ubidi_getProcessedLength(pBiDi)].
 *
 * @return The level for the character at charIndex (0 if charIndex is not
 *         in the valid range).
 *
 * @see UBiDiLevel
 * @see ubidi_getProcessedLength
 * @stable ICU 2.0
 */
U_CAPI UBiDiLevel U_EXPORT2
ubidi_getLevelAt(const UBiDi *pBiDi, int32_t charIndex);

/**
 * Get an array of levels for each character.<p>
 *
 * Note that this function may allocate memory under some
 * circumstances, unlike <code>ubidi_getLevelAt()</code>.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object, whose
 *        text length must be strictly positive.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @return The levels array for the text,
 *         or <code>NULL</code> if an error occurs.
 *
 * @see UBiDiLevel
 * @see ubidi_getProcessedLength
 * @stable ICU 2.0
 */
U_CAPI const UBiDiLevel * U_EXPORT2
ubidi_getLevels(UBiDi *pBiDi, UErrorCode *pErrorCode);

/**
 * Get a logical run.
 * This function returns information about a run and is used
 * to retrieve runs in logical order.<p>
 * This is especially useful for line-breaking on a paragraph.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param logicalPosition is a logical position within the source text.
 *
 * @param pLogicalLimit will receive the limit of the corresponding run.
 *        The l-value that you point to here may be the
 *        same expression (variable) as the one for
 *        <code>logicalPosition</code>.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @param pLevel will receive the level of the corresponding run.
 *        This pointer can be <code>NULL</code> if this
 *        value is not necessary.
 *
 * @see ubidi_getProcessedLength
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_getLogicalRun(const UBiDi *pBiDi, int32_t logicalPosition,
                    int32_t *pLogicalLimit, UBiDiLevel *pLevel);

/**
 * Get the number of runs.
 * This function may invoke the actual reordering on the
 * <code>UBiDi</code> object, after <code>ubidi_setPara()</code>
 * may have resolved only the levels of the text. Therefore,
 * <code>ubidi_countRuns()</code> may have to allocate memory,
 * and may fail doing so.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @return The number of runs.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubidi_countRuns(UBiDi *pBiDi, UErrorCode *pErrorCode);

/**
 * Get one run's logical start, length, and directionality,
 * which can be 0 for LTR or 1 for RTL.
 * In an RTL run, the character at the logical start is
 * visually on the right of the displayed run.
 * The length is the number of characters in the run.<p>
 * <code>ubidi_countRuns()</code> should be called
 * before the runs are retrieved.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param runIndex is the number of the run in visual order, in the
 *        range <code>[0..ubidi_countRuns(pBiDi)-1]</code>.
 *
 * @param pLogicalStart is the first logical character index in the text.
 *        The pointer may be <code>NULL</code> if this index is not needed.
 *
 * @param pLength is the number of characters (at least one) in the run.
 *        The pointer may be <code>NULL</code> if this is not needed.
 *
 * @return the directionality of the run,
 *         <code>UBIDI_LTR==0</code> or <code>UBIDI_RTL==1</code>,
 *         never <code>UBIDI_MIXED</code>,
 *         never <code>UBIDI_NEUTRAL</code>.
 *
 * @see ubidi_countRuns
 *
 * Example:
 * <pre>
 * \code
 * int32_t i, count=ubidi_countRuns(pBiDi),
 *         logicalStart, visualIndex=0, length;
 * for(i=0; i<count; ++i) {
 *    if(UBIDI_LTR==ubidi_getVisualRun(pBiDi, i, &logicalStart, &length)) {
 *         do { // LTR
 *             show_char(text[logicalStart++], visualIndex++);
 *         } while(--length>0);
 *     } else {
 *         logicalStart+=length;  // logicalLimit
 *         do { // RTL
 *             show_char(text[--logicalStart], visualIndex++);
 *         } while(--length>0);
 *     }
 * }
 *\endcode
 * </pre>
 *
 * Note that in right-to-left runs, code like this places
 * second surrogates before first ones (which is generally a bad idea)
 * and combining characters before base characters.
 * <p>
 * Use of <code>ubidi_writeReordered()</code>, optionally with the
 * <code>#UBIDI_KEEP_BASE_COMBINING</code> option, can be considered in order
 * to avoid these issues.
 * @stable ICU 2.0
 */
U_CAPI UBiDiDirection U_EXPORT2
ubidi_getVisualRun(UBiDi *pBiDi, int32_t runIndex,
                   int32_t *pLogicalStart, int32_t *pLength);

/**
 * Get the visual position from a logical text position.
 * If such a mapping is used many times on the same
 * <code>UBiDi</code> object, then calling
 * <code>ubidi_getLogicalMap()</code> is more efficient.<p>
 *
 * The value returned may be <code>#UBIDI_MAP_NOWHERE</code> if there is no
 * visual position because the corresponding text character is a Bidi control
 * removed from output by the option <code>#UBIDI_OPTION_REMOVE_CONTROLS</code>.
 * <p>
 * When the visual output is altered by using options of
 * <code>ubidi_writeReordered()</code> such as <code>UBIDI_INSERT_LRM_FOR_NUMERIC</code>,
 * <code>UBIDI_KEEP_BASE_COMBINING</code>, <code>UBIDI_OUTPUT_REVERSE</code>,
 * <code>UBIDI_REMOVE_BIDI_CONTROLS</code>, the visual position returned may not
 * be correct. It is advised to use, when possible, reordering options
 * such as <code>UBIDI_OPTION_INSERT_MARKS</code> and <code>UBIDI_OPTION_REMOVE_CONTROLS</code>.
 * <p>
 * Note that in right-to-left runs, this mapping places
 * second surrogates before first ones (which is generally a bad idea)
 * and combining characters before base characters.
 * Use of <code>ubidi_writeReordered()</code>, optionally with the
 * <code>#UBIDI_KEEP_BASE_COMBINING</code> option can be considered instead
 * of using the mapping, in order to avoid these issues.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param logicalIndex is the index of a character in the text.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @return The visual position of this character.
 *
 * @see ubidi_getLogicalMap
 * @see ubidi_getLogicalIndex
 * @see ubidi_getProcessedLength
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubidi_getVisualIndex(UBiDi *pBiDi, int32_t logicalIndex, UErrorCode *pErrorCode);

/**
 * Get the logical text position from a visual position.
 * If such a mapping is used many times on the same
 * <code>UBiDi</code> object, then calling
 * <code>ubidi_getVisualMap()</code> is more efficient.<p>
 *
 * The value returned may be <code>#UBIDI_MAP_NOWHERE</code> if there is no
 * logical position because the corresponding text character is a Bidi mark
 * inserted in the output by option <code>#UBIDI_OPTION_INSERT_MARKS</code>.
 * <p>
 * This is the inverse function to <code>ubidi_getVisualIndex()</code>.
 * <p>
 * When the visual output is altered by using options of
 * <code>ubidi_writeReordered()</code> such as <code>UBIDI_INSERT_LRM_FOR_NUMERIC</code>,
 * <code>UBIDI_KEEP_BASE_COMBINING</code>, <code>UBIDI_OUTPUT_REVERSE</code>,
 * <code>UBIDI_REMOVE_BIDI_CONTROLS</code>, the logical position returned may not
 * be correct. It is advised to use, when possible, reordering options
 * such as <code>UBIDI_OPTION_INSERT_MARKS</code> and <code>UBIDI_OPTION_REMOVE_CONTROLS</code>.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param visualIndex is the visual position of a character.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @return The index of this character in the text.
 *
 * @see ubidi_getVisualMap
 * @see ubidi_getVisualIndex
 * @see ubidi_getResultLength
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubidi_getLogicalIndex(UBiDi *pBiDi, int32_t visualIndex, UErrorCode *pErrorCode);

/**
 * Get a logical-to-visual index map (array) for the characters in the UBiDi
 * (paragraph or line) object.
 * <p>
 * Some values in the map may be <code>#UBIDI_MAP_NOWHERE</code> if the
 * corresponding text characters are Bidi controls removed from the visual
 * output by the option <code>#UBIDI_OPTION_REMOVE_CONTROLS</code>.
 * <p>
 * When the visual output is altered by using options of
 * <code>ubidi_writeReordered()</code> such as <code>UBIDI_INSERT_LRM_FOR_NUMERIC</code>,
 * <code>UBIDI_KEEP_BASE_COMBINING</code>, <code>UBIDI_OUTPUT_REVERSE</code>,
 * <code>UBIDI_REMOVE_BIDI_CONTROLS</code>, the visual positions returned may not
 * be correct. It is advised to use, when possible, reordering options
 * such as <code>UBIDI_OPTION_INSERT_MARKS</code> and <code>UBIDI_OPTION_REMOVE_CONTROLS</code>.
 * <p>
 * Note that in right-to-left runs, this mapping places
 * second surrogates before first ones (which is generally a bad idea)
 * and combining characters before base characters.
 * Use of <code>ubidi_writeReordered()</code>, optionally with the
 * <code>#UBIDI_KEEP_BASE_COMBINING</code> option can be considered instead
 * of using the mapping, in order to avoid these issues.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param indexMap is a pointer to an array of <code>ubidi_getProcessedLength()</code>
 *        indexes which will reflect the reordering of the characters.
 *        If option <code>#UBIDI_OPTION_INSERT_MARKS</code> is set, the number
 *        of elements allocated in <code>indexMap</code> must be no less than
 *        <code>ubidi_getResultLength()</code>.
 *        The array does not need to be initialized.<br><br>
 *        The index map will result in <code>indexMap[logicalIndex]==visualIndex</code>.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @see ubidi_getVisualMap
 * @see ubidi_getVisualIndex
 * @see ubidi_getProcessedLength
 * @see ubidi_getResultLength
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_getLogicalMap(UBiDi *pBiDi, int32_t *indexMap, UErrorCode *pErrorCode);

/**
 * Get a visual-to-logical index map (array) for the characters in the UBiDi
 * (paragraph or line) object.
 * <p>
 * Some values in the map may be <code>#UBIDI_MAP_NOWHERE</code> if the
 * corresponding text characters are Bidi marks inserted in the visual output
 * by the option <code>#UBIDI_OPTION_INSERT_MARKS</code>.
 * <p>
 * When the visual output is altered by using options of
 * <code>ubidi_writeReordered()</code> such as <code>UBIDI_INSERT_LRM_FOR_NUMERIC</code>,
 * <code>UBIDI_KEEP_BASE_COMBINING</code>, <code>UBIDI_OUTPUT_REVERSE</code>,
 * <code>UBIDI_REMOVE_BIDI_CONTROLS</code>, the logical positions returned may not
 * be correct. It is advised to use, when possible, reordering options
 * such as <code>UBIDI_OPTION_INSERT_MARKS</code> and <code>UBIDI_OPTION_REMOVE_CONTROLS</code>.
 *
 * @param pBiDi is the paragraph or line <code>UBiDi</code> object.
 *
 * @param indexMap is a pointer to an array of <code>ubidi_getResultLength()</code>
 *        indexes which will reflect the reordering of the characters.
 *        If option <code>#UBIDI_OPTION_REMOVE_CONTROLS</code> is set, the number
 *        of elements allocated in <code>indexMap</code> must be no less than
 *        <code>ubidi_getProcessedLength()</code>.
 *        The array does not need to be initialized.<br><br>
 *        The index map will result in <code>indexMap[visualIndex]==logicalIndex</code>.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @see ubidi_getLogicalMap
 * @see ubidi_getLogicalIndex
 * @see ubidi_getProcessedLength
 * @see ubidi_getResultLength
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_getVisualMap(UBiDi *pBiDi, int32_t *indexMap, UErrorCode *pErrorCode);

/**
 * This is a convenience function that does not use a UBiDi object.
 * It is intended to be used for when an application has determined the levels
 * of objects (character sequences) and just needs to have them reordered (L2).
 * This is equivalent to using <code>ubidi_getLogicalMap()</code> on a
 * <code>UBiDi</code> object.
 *
 * @param levels is an array with <code>length</code> levels that have been determined by
 *        the application.
 *
 * @param length is the number of levels in the array, or, semantically,
 *        the number of objects to be reordered.
 *        It must be <code>length>0</code>.
 *
 * @param indexMap is a pointer to an array of <code>length</code>
 *        indexes which will reflect the reordering of the characters.
 *        The array does not need to be initialized.<p>
 *        The index map will result in <code>indexMap[logicalIndex]==visualIndex</code>.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_reorderLogical(const UBiDiLevel *levels, int32_t length, int32_t *indexMap);

/**
 * This is a convenience function that does not use a UBiDi object.
 * It is intended to be used for when an application has determined the levels
 * of objects (character sequences) and just needs to have them reordered (L2).
 * This is equivalent to using <code>ubidi_getVisualMap()</code> on a
 * <code>UBiDi</code> object.
 *
 * @param levels is an array with <code>length</code> levels that have been determined by
 *        the application.
 *
 * @param length is the number of levels in the array, or, semantically,
 *        the number of objects to be reordered.
 *        It must be <code>length>0</code>.
 *
 * @param indexMap is a pointer to an array of <code>length</code>
 *        indexes which will reflect the reordering of the characters.
 *        The array does not need to be initialized.<p>
 *        The index map will result in <code>indexMap[visualIndex]==logicalIndex</code>.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_reorderVisual(const UBiDiLevel *levels, int32_t length, int32_t *indexMap);

/**
 * Invert an index map.
 * The index mapping of the first map is inverted and written to
 * the second one.
 *
 * @param srcMap is an array with <code>length</code> elements
 *        which defines the original mapping from a source array containing
 *        <code>length</code> elements to a destination array.
 *        Some elements of the source array may have no mapping in the
 *        destination array. In that case, their value will be
 *        the special value <code>UBIDI_MAP_NOWHERE</code>.
 *        All elements must be >=0 or equal to <code>UBIDI_MAP_NOWHERE</code>.
 *        Some elements may have a value >= <code>length</code>, if the
 *        destination array has more elements than the source array.
 *        There must be no duplicate indexes (two or more elements with the
 *        same value except <code>UBIDI_MAP_NOWHERE</code>).
 *
 * @param destMap is an array with a number of elements equal to 1 + the highest
 *        value in <code>srcMap</code>.
 *        <code>destMap</code> will be filled with the inverse mapping.
 *        If element with index i in <code>srcMap</code> has a value k different
 *        from <code>UBIDI_MAP_NOWHERE</code>, this means that element i of
 *        the source array maps to element k in the destination array.
 *        The inverse map will have value i in its k-th element.
 *        For all elements of the destination array which do not map to
 *        an element in the source array, the corresponding element in the
 *        inverse map will have a value equal to <code>UBIDI_MAP_NOWHERE</code>.
 *
 * @param length is the length of each array.
 * @see UBIDI_MAP_NOWHERE
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ubidi_invertMap(const int32_t *srcMap, int32_t *destMap, int32_t length);

/** option flags for ubidi_writeReordered() */

/**
 * option bit for ubidi_writeReordered():
 * keep combining characters after their base characters in RTL runs
 *
 * @see ubidi_writeReordered
 * @stable ICU 2.0
 */
#define UBIDI_KEEP_BASE_COMBINING       1

/**
 * option bit for ubidi_writeReordered():
 * replace characters with the "mirrored" property in RTL runs
 * by their mirror-image mappings
 *
 * @see ubidi_writeReordered
 * @stable ICU 2.0
 */
#define UBIDI_DO_MIRRORING              2

/**
 * option bit for ubidi_writeReordered():
 * surround the run with LRMs if necessary;
 * this is part of the approximate "inverse Bidi" algorithm
 *
 * <p>This option does not imply corresponding adjustment of the index
 * mappings.</p>
 *
 * @see ubidi_setInverse
 * @see ubidi_writeReordered
 * @stable ICU 2.0
 */
#define UBIDI_INSERT_LRM_FOR_NUMERIC    4

/**
 * option bit for ubidi_writeReordered():
 * remove Bidi control characters
 * (this does not affect #UBIDI_INSERT_LRM_FOR_NUMERIC)
 *
 * <p>This option does not imply corresponding adjustment of the index
 * mappings.</p>
 *
 * @see ubidi_writeReordered
 * @stable ICU 2.0
 */
#define UBIDI_REMOVE_BIDI_CONTROLS      8

/**
 * option bit for ubidi_writeReordered():
 * write the output in reverse order
 *
 * <p>This has the same effect as calling <code>ubidi_writeReordered()</code>
 * first without this option, and then calling
 * <code>ubidi_writeReverse()</code> without mirroring.
 * Doing this in the same step is faster and avoids a temporary buffer.
 * An example for using this option is output to a character terminal that
 * is designed for RTL scripts and stores text in reverse order.</p>
 *
 * @see ubidi_writeReordered
 * @stable ICU 2.0
 */
#define UBIDI_OUTPUT_REVERSE            16

/**
 * Get the length of the source text processed by the last call to
 * <code>ubidi_setPara()</code>. This length may be different from the length
 * of the source text if option <code>#UBIDI_OPTION_STREAMING</code>
 * has been set.
 * <br>
 * Note that whenever the length of the text affects the execution or the
 * result of a function, it is the processed length which must be considered,
 * except for <code>ubidi_setPara</code> (which receives unprocessed source
 * text) and <code>ubidi_getLength</code> (which returns the original length
 * of the source text).<br>
 * In particular, the processed length is the one to consider in the following
 * cases:
 * <ul>
 * <li>maximum value of the <code>limit</code> argument of
 * <code>ubidi_setLine</code></li>
 * <li>maximum value of the <code>charIndex</code> argument of
 * <code>ubidi_getParagraph</code></li>
 * <li>maximum value of the <code>charIndex</code> argument of
 * <code>ubidi_getLevelAt</code></li>
 * <li>number of elements in the array returned by <code>ubidi_getLevels</code></li>
 * <li>maximum value of the <code>logicalStart</code> argument of
 * <code>ubidi_getLogicalRun</code></li>
 * <li>maximum value of the <code>logicalIndex</code> argument of
 * <code>ubidi_getVisualIndex</code></li>
 * <li>number of elements filled in the <code>*indexMap</code> argument of
 * <code>ubidi_getLogicalMap</code></li>
 * <li>length of text processed by <code>ubidi_writeReordered</code></li>
 * </ul>
 *
 * @param pBiDi is the paragraph <code>UBiDi</code> object.
 *
 * @return The length of the part of the source text processed by
 *         the last call to <code>ubidi_setPara</code>.
 * @see ubidi_setPara
 * @see UBIDI_OPTION_STREAMING
 * @stable ICU 3.6
 */
U_CAPI int32_t U_EXPORT2
ubidi_getProcessedLength(const UBiDi *pBiDi);

/**
 * Get the length of the reordered text resulting from the last call to
 * <code>ubidi_setPara()</code>. This length may be different from the length
 * of the source text if option <code>#UBIDI_OPTION_INSERT_MARKS</code>
 * or option <code>#UBIDI_OPTION_REMOVE_CONTROLS</code> has been set.
 * <br>
 * This resulting length is the one to consider in the following cases:
 * <ul>
 * <li>maximum value of the <code>visualIndex</code> argument of
 * <code>ubidi_getLogicalIndex</code></li>
 * <li>number of elements of the <code>*indexMap</code> argument of
 * <code>ubidi_getVisualMap</code></li>
 * </ul>
 * Note that this length stays identical to the source text length if
 * Bidi marks are inserted or removed using option bits of
 * <code>ubidi_writeReordered</code>, or if option
 * <code>#UBIDI_REORDER_INVERSE_NUMBERS_AS_L</code> has been set.
 *
 * @param pBiDi is the paragraph <code>UBiDi</code> object.
 *
 * @return The length of the reordered text resulting from
 *         the last call to <code>ubidi_setPara</code>.
 * @see ubidi_setPara
 * @see UBIDI_OPTION_INSERT_MARKS
 * @see UBIDI_OPTION_REMOVE_CONTROLS
 * @stable ICU 3.6
 */
U_CAPI int32_t U_EXPORT2
ubidi_getResultLength(const UBiDi *pBiDi);

U_CDECL_BEGIN

#ifndef U_HIDE_DEPRECATED_API
/**
 * Value returned by <code>UBiDiClassCallback</code> callbacks when
 * there is no need to override the standard Bidi class for a given code point.
 *
 * This constant is deprecated; use u_getIntPropertyMaxValue(UCHAR_BIDI_CLASS)+1 instead.
 *
 * @see UBiDiClassCallback
 * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
 */
#define U_BIDI_CLASS_DEFAULT  U_CHAR_DIRECTION_COUNT
#endif  // U_HIDE_DEPRECATED_API

/**
 * Callback type declaration for overriding default Bidi class values with
 * custom ones.
 * <p>Usually, the function pointer will be propagated to a <code>UBiDi</code>
 * object by calling the <code>ubidi_setClassCallback()</code> function;
 * then the callback will be invoked by the UBA implementation any time the
 * class of a character is to be determined.</p>
 *
 * @param context is a pointer to the callback private data.
 *
 * @param c       is the code point to get a Bidi class for.
 *
 * @return The directional property / Bidi class for the given code point
 *         <code>c</code> if the default class has been overridden, or
 *         <code>u_getIntPropertyMaxValue(UCHAR_BIDI_CLASS)+1</code>
 *         if the standard Bidi class value for <code>c</code> is to be used.
 * @see ubidi_setClassCallback
 * @see ubidi_getClassCallback
 * @stable ICU 3.6
 */
typedef UCharDirection U_CALLCONV
UBiDiClassCallback(const void *context, UChar32 c);

U_CDECL_END

/**
 * Retrieve the Bidi class for a given code point.
 * <p>If a <code>#UBiDiClassCallback</code> callback is defined and returns a
 * value other than <code>u_getIntPropertyMaxValue(UCHAR_BIDI_CLASS)+1</code>,
 * that value is used; otherwise the default class determination mechanism is invoked.</p>
 *
 * @param pBiDi is the paragraph <code>UBiDi</code> object.
 *
 * @param c     is the code point whose Bidi class must be retrieved.
 *
 * @return The Bidi class for character <code>c</code> based
 *         on the given <code>pBiDi</code> instance.
 * @see UBiDiClassCallback
 * @stable ICU 3.6
 */
U_CAPI UCharDirection U_EXPORT2
ubidi_getCustomizedClass(UBiDi *pBiDi, UChar32 c);

/**
 * Set the callback function and callback data used by the UBA
 * implementation for Bidi class determination.
 * <p>This may be useful for assigning Bidi classes to PUA characters, or
 * for special application needs. For instance, an application may want to
 * handle all spaces like L or R characters (according to the base direction)
 * when creating the visual ordering of logical lines which are part of a report
 * organized in columns: there should not be interaction between adjacent
 * cells.<p>
 *
 * @param pBiDi is the paragraph <code>UBiDi</code> object.
 *
 * @param newFn is the new callback function pointer.
 *
 * @param newContext is the new callback context pointer. This can be NULL.
 *
 * @param oldFn fillin: Returns the old callback function pointer. This can be
 *                      NULL.
 *
 * @param oldContext fillin: Returns the old callback's context. This can be
 *                           NULL.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @see ubidi_getClassCallback
 * @stable ICU 3.6
 */
U_CAPI void U_EXPORT2
ubidi_setClassCallback(UBiDi *pBiDi, UBiDiClassCallback *newFn,
                       const void *newContext, UBiDiClassCallback **oldFn,
                       const void **oldContext, UErrorCode *pErrorCode);

/**
 * Get the current callback function used for Bidi class determination.
 *
 * @param pBiDi is the paragraph <code>UBiDi</code> object.
 *
 * @param fn fillin: Returns the callback function pointer.
 *
 * @param context fillin: Returns the callback's private context.
 *
 * @see ubidi_setClassCallback
 * @stable ICU 3.6
 */
U_CAPI void U_EXPORT2
ubidi_getClassCallback(UBiDi *pBiDi, UBiDiClassCallback **fn, const void **context);

/**
 * Take a <code>UBiDi</code> object containing the reordering
 * information for a piece of text (one or more paragraphs) set by
 * <code>ubidi_setPara()</code> or for a line of text set by
 * <code>ubidi_setLine()</code> and write a reordered string to the
 * destination buffer.
 *
 * This function preserves the integrity of characters with multiple
 * code units and (optionally) combining characters.
 * Characters in RTL runs can be replaced by mirror-image characters
 * in the destination buffer. Note that "real" mirroring has
 * to be done in a rendering engine by glyph selection
 * and that for many "mirrored" characters there are no
 * Unicode characters as mirror-image equivalents.
 * There are also options to insert or remove Bidi control
 * characters; see the description of the <code>destSize</code>
 * and <code>options</code> parameters and of the option bit flags.
 *
 * @param pBiDi A pointer to a <code>UBiDi</code> object that
 *              is set by <code>ubidi_setPara()</code> or
 *              <code>ubidi_setLine()</code> and contains the reordering
 *              information for the text that it was defined for,
 *              as well as a pointer to that text.<br><br>
 *              The text was aliased (only the pointer was stored
 *              without copying the contents) and must not have been modified
 *              since the <code>ubidi_setPara()</code> call.
 *
 * @param dest A pointer to where the reordered text is to be copied.
 *             The source text and <code>dest[destSize]</code>
 *             must not overlap.
 *
 * @param destSize The size of the <code>dest</code> buffer,
 *                 in number of UChars.
 *                 If the <code>UBIDI_INSERT_LRM_FOR_NUMERIC</code>
 *                 option is set, then the destination length could be
 *                 as large as
 *                 <code>ubidi_getLength(pBiDi)+2*ubidi_countRuns(pBiDi)</code>.
 *                 If the <code>UBIDI_REMOVE_BIDI_CONTROLS</code> option
 *                 is set, then the destination length may be less than
 *                 <code>ubidi_getLength(pBiDi)</code>.
 *                 If none of these options is set, then the destination length
 *                 will be exactly <code>ubidi_getProcessedLength(pBiDi)</code>.
 *
 * @param options A bit set of options for the reordering that control
 *                how the reordered text is written.
 *                The options include mirroring the characters on a code
 *                point basis and inserting LRM characters, which is used
 *                especially for transforming visually stored text
 *                to logically stored text (although this is still an
 *                imperfect implementation of an "inverse Bidi" algorithm
 *                because it uses the "forward Bidi" algorithm at its core).
 *                The available options are:
 *                <code>#UBIDI_DO_MIRRORING</code>,
 *                <code>#UBIDI_INSERT_LRM_FOR_NUMERIC</code>,
 *                <code>#UBIDI_KEEP_BASE_COMBINING</code>,
 *                <code>#UBIDI_OUTPUT_REVERSE</code>,
 *                <code>#UBIDI_REMOVE_BIDI_CONTROLS</code>
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @return The length of the output string.
 *
 * @see ubidi_getProcessedLength
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubidi_writeReordered(UBiDi *pBiDi,
                     UChar *dest, int32_t destSize,
                     uint16_t options,
                     UErrorCode *pErrorCode);

/**
 * Reverse a Right-To-Left run of Unicode text.
 *
 * This function preserves the integrity of characters with multiple
 * code units and (optionally) combining characters.
 * Characters can be replaced by mirror-image characters
 * in the destination buffer. Note that "real" mirroring has
 * to be done in a rendering engine by glyph selection
 * and that for many "mirrored" characters there are no
 * Unicode characters as mirror-image equivalents.
 * There are also options to insert or remove Bidi control
 * characters.
 *
 * This function is the implementation for reversing RTL runs as part
 * of <code>ubidi_writeReordered()</code>. For detailed descriptions
 * of the parameters, see there.
 * Since no Bidi controls are inserted here, the output string length
 * will never exceed <code>srcLength</code>.
 *
 * @see ubidi_writeReordered
 *
 * @param src A pointer to the RTL run text.
 *
 * @param srcLength The length of the RTL run.
 *
 * @param dest A pointer to where the reordered text is to be copied.
 *             <code>src[srcLength]</code> and <code>dest[destSize]</code>
 *             must not overlap.
 *
 * @param destSize The size of the <code>dest</code> buffer,
 *                 in number of UChars.
 *                 If the <code>UBIDI_REMOVE_BIDI_CONTROLS</code> option
 *                 is set, then the destination length may be less than
 *                 <code>srcLength</code>.
 *                 If this option is not set, then the destination length
 *                 will be exactly <code>srcLength</code>.
 *
 * @param options A bit set of options for the reordering that control
 *                how the reordered text is written.
 *                See the <code>options</code> parameter in <code>ubidi_writeReordered()</code>.
 *
 * @param pErrorCode must be a valid pointer to an error code value.
 *
 * @return The length of the output string.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ubidi_writeReverse(const UChar *src, int32_t srcLength,
                   UChar *dest, int32_t destSize,
                   uint16_t options,
                   UErrorCode *pErrorCode);

/*#define BIDI_SAMPLE_CODE*/
/*@}*/

#endif
