// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 1999-2005, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
*   Date        Name        Description
*   03/14/00    aliu        Creation.
*   06/27/00    aliu        Change from C++ class to C struct
**********************************************************************
*/
#ifndef PARSEERR_H
#define PARSEERR_H

#include "unicode/utypes.h"


/**
 * \file
 * \brief C API: Parse Error Information
 */
/**
 * The capacity of the context strings in UParseError.
 * @stable ICU 2.0
 */ 
enum { U_PARSE_CONTEXT_LEN = 16 };

/**
 * A UParseError struct is used to returned detailed information about
 * parsing errors.  It is used by ICU parsing engines that parse long
 * rules, patterns, or programs, where the text being parsed is long
 * enough that more information than a UErrorCode is needed to
 * localize the error.
 *
 * <p>The line, offset, and context fields are optional; parsing
 * engines may choose not to use to use them.
 *
 * <p>The preContext and postContext strings include some part of the
 * context surrounding the error.  If the source text is "let for=7"
 * and "for" is the error (e.g., because it is a reserved word), then
 * some examples of what a parser might produce are the following:
 *
 * <pre>
 * preContext   postContext
 * ""           ""            The parser does not support context
 * "let "       "=7"          Pre- and post-context only
 * "let "       "for=7"       Pre- and post-context and error text
 * ""           "for"         Error text only
 * </pre>
 *
 * <p>Examples of engines which use UParseError (or may use it in the
 * future) are Transliterator, RuleBasedBreakIterator, and
 * RegexPattern.
 * 
 * @stable ICU 2.0
 */
typedef struct UParseError {

    /**
     * The line on which the error occurred.  If the parser uses this
     * field, it sets it to the line number of the source text line on
     * which the error appears, which will be a value >= 1.  If the
     * parse does not support line numbers, the value will be <= 0.
     * @stable ICU 2.0
     */
    int32_t        line;

    /**
     * The character offset to the error.  If the line field is >= 1,
     * then this is the offset from the start of the line.  Otherwise,
     * this is the offset from the start of the text.  If the parser
     * does not support this field, it will have a value < 0.
     * @stable ICU 2.0
     */
    int32_t        offset;

    /**
     * Textual context before the error.  Null-terminated.  The empty
     * string if not supported by parser.
     * @stable ICU 2.0   
     */
    UChar          preContext[U_PARSE_CONTEXT_LEN];

    /**
     * The error itself and/or textual context after the error.
     * Null-terminated.  The empty string if not supported by parser.
     * @stable ICU 2.0   
     */
    UChar          postContext[U_PARSE_CONTEXT_LEN];

} UParseError;

#endif
