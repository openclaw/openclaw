// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/********************************************************************
 * COPYRIGHT: 
 * Copyright (c) 1997-2011, International Business Machines Corporation and
 * others. All Rights Reserved.
 * Copyright (C) 2010 , Yahoo! Inc. 
 ********************************************************************
 *
 *   file name:  umsg.h
 *   encoding:   UTF-8
 *   tab size:   8 (not used)
 *   indentation:4
 *
 *   Change history:
 *
 *   08/5/2001  Ram         Added C wrappers for C++ API.
 ********************************************************************/

#ifndef UMSG_H
#define UMSG_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/uloc.h"
#include "unicode/parseerr.h"
#include <stdarg.h>

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: MessageFormat
 *
 * <h2>MessageFormat C API </h2>
 *
 * <p>MessageFormat prepares strings for display to users,
 * with optional arguments (variables/placeholders).
 * The arguments can occur in any order, which is necessary for translation
 * into languages with different grammars.
 *
 * <p>The opaque UMessageFormat type is a thin C wrapper around
 * a C++ MessageFormat. It is constructed from a <em>pattern</em> string
 * with arguments in {curly braces} which will be replaced by formatted values.
 *
 * <p>Currently, the C API supports only numbered arguments.
 *
 * <p>For details about the pattern syntax and behavior,
 * especially about the ASCII apostrophe vs. the
 * real apostrophe (single quote) character \htmlonly&#x2019;\endhtmlonly (U+2019),
 * see the C++ MessageFormat class documentation.
 *
 * <p>Here are some examples of C API usage:
 * Example 1:
 * <pre>
 * \code
 *     UChar *result, *tzID, *str;
 *     UChar pattern[100];
 *     int32_t resultLengthOut, resultlength;
 *     UCalendar *cal;
 *     UDate d1;
 *     UDateFormat *def1;
 *     UErrorCode status = U_ZERO_ERROR;
 *
 *     str=(UChar*)malloc(sizeof(UChar) * (strlen("disturbance in force") +1));
 *     u_uastrcpy(str, "disturbance in force");
 *     tzID=(UChar*)malloc(sizeof(UChar) * 4);
 *     u_uastrcpy(tzID, "PST");
 *     cal=ucal_open(tzID, u_strlen(tzID), "en_US", UCAL_TRADITIONAL, &status);
 *     ucal_setDateTime(cal, 1999, UCAL_MARCH, 18, 0, 0, 0, &status);
 *     d1=ucal_getMillis(cal, &status);
 *     u_uastrcpy(pattern, "On {0, date, long}, there was a {1} on planet {2,number,integer}");
 *     resultlength=0;
 *     resultLengthOut=u_formatMessage( "en_US", pattern, u_strlen(pattern), NULL, resultlength, &status, d1, str, 7);
 *     if(status==U_BUFFER_OVERFLOW_ERROR){
 *         status=U_ZERO_ERROR;
 *         resultlength=resultLengthOut+1;
 *         result=(UChar*)realloc(result, sizeof(UChar) * resultlength);
 *         u_formatMessage( "en_US", pattern, u_strlen(pattern), result, resultlength, &status, d1, str, 7);
 *     }
 *     printf("%s\n", austrdup(result) );//austrdup( a function used to convert UChar* to char*)
 *     //output>: "On March 18, 1999, there was a disturbance in force on planet 7
 * \endcode
 * </pre>
 * Typically, the message format will come from resources, and the
 * arguments will be dynamically set at runtime.
 * <P>
 * Example 2:
 * <pre>
 * \code
 *     UChar* str;
 *     UErrorCode status = U_ZERO_ERROR;
 *     UChar *result;
 *     UChar pattern[100];
 *     int32_t resultlength, resultLengthOut, i;
 *     double testArgs= { 100.0, 1.0, 0.0};
 *
 *     str=(UChar*)malloc(sizeof(UChar) * 10);
 *     u_uastrcpy(str, "MyDisk");
 *     u_uastrcpy(pattern, "The disk {1} contains {0,choice,0#no files|1#one file|1<{0,number,integer} files}");
 *     for(i=0; i<3; i++){
 *       resultlength=0; 
 *       resultLengthOut=u_formatMessage( "en_US", pattern, u_strlen(pattern), NULL, resultlength, &status, testArgs[i], str); 
 *       if(status==U_BUFFER_OVERFLOW_ERROR){
 *         status=U_ZERO_ERROR;
 *         resultlength=resultLengthOut+1;
 *         result=(UChar*)malloc(sizeof(UChar) * resultlength);
 *         u_formatMessage( "en_US", pattern, u_strlen(pattern), result, resultlength, &status, testArgs[i], str);
 *       }
 *       printf("%s\n", austrdup(result) );  //austrdup( a function used to convert UChar* to char*)
 *       free(result);
 *     }
 *     // output, with different testArgs:
 *     // output: The disk "MyDisk" contains 100 files.
 *     // output: The disk "MyDisk" contains one file.
 *     // output: The disk "MyDisk" contains no files.
 * \endcode
 *  </pre>
 *
 *
 * Example 3:
 * <pre>
 * \code
 * UChar* str;
 * UChar* str1;
 * UErrorCode status = U_ZERO_ERROR;
 * UChar *result;
 * UChar pattern[100];
 * UChar expected[100];
 * int32_t resultlength,resultLengthOut;

 * str=(UChar*)malloc(sizeof(UChar) * 25);
 * u_uastrcpy(str, "Kirti");
 * str1=(UChar*)malloc(sizeof(UChar) * 25);
 * u_uastrcpy(str1, "female");
 * log_verbose("Testing message format with Select test #1\n:");
 * u_uastrcpy(pattern, "{0} est {1, select, female {all\\u00E9e} other {all\\u00E9}} \\u00E0 Paris.");
 * u_uastrcpy(expected, "Kirti est all\\u00E9e \\u00E0 Paris.");
 * resultlength=0;
 * resultLengthOut=u_formatMessage( "fr", pattern, u_strlen(pattern), NULL, resultlength, &status, str , str1);
 * if(status==U_BUFFER_OVERFLOW_ERROR)
 *  {
 *      status=U_ZERO_ERROR;
 *      resultlength=resultLengthOut+1;
 *      result=(UChar*)malloc(sizeof(UChar) * resultlength);
 *      u_formatMessage( "fr", pattern, u_strlen(pattern), result, resultlength, &status, str , str1);
 *      if(u_strcmp(result, expected)==0)
 *          log_verbose("PASS: MessagFormat successful on Select test#1\n");
 *      else{
 *          log_err("FAIL: Error in MessageFormat on Select test#1\n GOT %s EXPECTED %s\n", austrdup(result),
 *          austrdup(expected) );
 *      }
 *      free(result);
 * }
 * \endcode
 *  </pre>
 */

/**
 * Format a message for a locale.
 * This function may perform re-ordering of the arguments depending on the
 * locale. For all numeric arguments, double is assumed unless the type is
 * explicitly integer.  All choice format arguments must be of type double.
 * @param locale The locale for which the message will be formatted
 * @param pattern The pattern specifying the message's format
 * @param patternLength The length of pattern
 * @param result A pointer to a buffer to receive the formatted message.
 * @param resultLength The maximum size of result.
 * @param status A pointer to an UErrorCode to receive any errors
 * @param ... A variable-length argument list containing the arguments specified
 * in pattern.
 * @return The total buffer size needed; if greater than resultLength, the
 * output was truncated.
 * @see u_parseMessage
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
u_formatMessage(const char  *locale,
                 const UChar *pattern,
                int32_t     patternLength,
                UChar       *result,
                int32_t     resultLength,
                UErrorCode  *status,
                ...);

/**
 * Format a message for a locale.
 * This function may perform re-ordering of the arguments depending on the
 * locale. For all numeric arguments, double is assumed unless the type is
 * explicitly integer.  All choice format arguments must be of type double.
 * @param locale The locale for which the message will be formatted
 * @param pattern The pattern specifying the message's format
 * @param patternLength The length of pattern
 * @param result A pointer to a buffer to receive the formatted message.
 * @param resultLength The maximum size of result.
 * @param ap A variable-length argument list containing the arguments specified
 * @param status A pointer to an UErrorCode to receive any errors
 * in pattern.
 * @return The total buffer size needed; if greater than resultLength, the
 * output was truncated.
 * @see u_parseMessage
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
u_vformatMessage(   const char  *locale,
                    const UChar *pattern,
                    int32_t     patternLength,
                    UChar       *result,
                    int32_t     resultLength,
                    va_list     ap,
                    UErrorCode  *status);

/**
 * Parse a message.
 * For numeric arguments, this function will always use doubles.  Integer types
 * should not be passed.
 * This function is not able to parse all output from {@link #u_formatMessage }.
 * @param locale The locale for which the message is formatted
 * @param pattern The pattern specifying the message's format
 * @param patternLength The length of pattern
 * @param source The text to parse.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param status A pointer to an UErrorCode to receive any errors
 * @param ... A variable-length argument list containing the arguments
 * specified in pattern.
 * @see u_formatMessage
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
u_parseMessage( const char   *locale,
                const UChar  *pattern,
                int32_t      patternLength,
                const UChar  *source,
                int32_t      sourceLength,
                UErrorCode   *status,
                ...);

/**
 * Parse a message.
 * For numeric arguments, this function will always use doubles.  Integer types
 * should not be passed.
 * This function is not able to parse all output from {@link #u_formatMessage }.
 * @param locale The locale for which the message is formatted
 * @param pattern The pattern specifying the message's format
 * @param patternLength The length of pattern
 * @param source The text to parse.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param ap A variable-length argument list containing the arguments
 * @param status A pointer to an UErrorCode to receive any errors
 * specified in pattern.
 * @see u_formatMessage
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
u_vparseMessage(const char  *locale,
                const UChar *pattern,
                int32_t     patternLength,
                const UChar *source,
                int32_t     sourceLength,
                va_list     ap,
                UErrorCode  *status);

/**
 * Format a message for a locale.
 * This function may perform re-ordering of the arguments depending on the
 * locale. For all numeric arguments, double is assumed unless the type is
 * explicitly integer.  All choice format arguments must be of type double.
 * @param locale The locale for which the message will be formatted
 * @param pattern The pattern specifying the message's format
 * @param patternLength The length of pattern
 * @param result A pointer to a buffer to receive the formatted message.
 * @param resultLength The maximum size of result.
 * @param status A pointer to an UErrorCode to receive any errors
 * @param ... A variable-length argument list containing the arguments specified
 * in pattern.
 * @param parseError  A pointer to UParseError to receive information about errors
 *                     occurred during parsing.
 * @return The total buffer size needed; if greater than resultLength, the
 * output was truncated.
 * @see u_parseMessage
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
u_formatMessageWithError(   const char    *locale,
                            const UChar   *pattern,
                            int32_t       patternLength,
                            UChar         *result,
                            int32_t       resultLength,
                            UParseError   *parseError,
                            UErrorCode    *status,
                            ...);

/**
 * Format a message for a locale.
 * This function may perform re-ordering of the arguments depending on the
 * locale. For all numeric arguments, double is assumed unless the type is
 * explicitly integer.  All choice format arguments must be of type double.
 * @param locale The locale for which the message will be formatted
 * @param pattern The pattern specifying the message's format
 * @param patternLength The length of pattern
 * @param result A pointer to a buffer to receive the formatted message.
 * @param resultLength The maximum size of result.
 * @param parseError  A pointer to UParseError to receive information about errors
 *                    occurred during parsing.
 * @param ap A variable-length argument list containing the arguments specified
 * @param status A pointer to an UErrorCode to receive any errors
 * in pattern.
 * @return The total buffer size needed; if greater than resultLength, the
 * output was truncated.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
u_vformatMessageWithError(  const char   *locale,
                            const UChar  *pattern,
                            int32_t      patternLength,
                            UChar        *result,
                            int32_t      resultLength,
                            UParseError* parseError,
                            va_list      ap,
                            UErrorCode   *status);

/**
 * Parse a message.
 * For numeric arguments, this function will always use doubles.  Integer types
 * should not be passed.
 * This function is not able to parse all output from {@link #u_formatMessage }.
 * @param locale The locale for which the message is formatted
 * @param pattern The pattern specifying the message's format
 * @param patternLength The length of pattern
 * @param source The text to parse.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param parseError  A pointer to UParseError to receive information about errors
 *                     occurred during parsing.
 * @param status A pointer to an UErrorCode to receive any errors
 * @param ... A variable-length argument list containing the arguments
 * specified in pattern.
 * @see u_formatMessage
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
u_parseMessageWithError(const char  *locale,
                        const UChar *pattern,
                        int32_t     patternLength,
                        const UChar *source,
                        int32_t     sourceLength,
                        UParseError *parseError,
                        UErrorCode  *status,
                        ...);

/**
 * Parse a message.
 * For numeric arguments, this function will always use doubles.  Integer types
 * should not be passed.
 * This function is not able to parse all output from {@link #u_formatMessage }.
 * @param locale The locale for which the message is formatted
 * @param pattern The pattern specifying the message's format
 * @param patternLength The length of pattern
 * @param source The text to parse.
 * @param sourceLength The length of source, or -1 if null-terminated.
 * @param ap A variable-length argument list containing the arguments
 * @param parseError  A pointer to UParseError to receive information about errors
 *                     occurred during parsing.
 * @param status A pointer to an UErrorCode to receive any errors
 * specified in pattern.
 * @see u_formatMessage
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
u_vparseMessageWithError(const char  *locale,
                         const UChar *pattern,
                         int32_t     patternLength,
                         const UChar *source,
                         int32_t     sourceLength,
                         va_list     ap,
                         UParseError *parseError,
                         UErrorCode* status);

/*----------------------- New experimental API --------------------------- */
/** 
 * The message format object
 * @stable ICU 2.0
 */
typedef void* UMessageFormat;


/**
 * Open a message formatter with given pattern and for the given locale.
 * @param pattern       A pattern specifying the format to use.
 * @param patternLength Length of the pattern to use
 * @param locale        The locale for which the messages are formatted.
 * @param parseError    A pointer to UParseError struct to receive any errors 
 *                      occurred during parsing. Can be NULL.
 * @param status        A pointer to an UErrorCode to receive any errors.
 * @return              A pointer to a UMessageFormat to use for formatting 
 *                      messages, or 0 if an error occurred. 
 * @stable ICU 2.0
 */
U_CAPI UMessageFormat* U_EXPORT2 
umsg_open(  const UChar     *pattern,
            int32_t         patternLength,
            const  char     *locale,
            UParseError     *parseError,
            UErrorCode      *status);

/**
 * Close a UMessageFormat.
 * Once closed, a UMessageFormat may no longer be used.
 * @param format The formatter to close.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
umsg_close(UMessageFormat* format);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUMessageFormatPointer
 * "Smart pointer" class, closes a UMessageFormat via umsg_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUMessageFormatPointer, UMessageFormat, umsg_close);

U_NAMESPACE_END

#endif

/**
 * Open a copy of a UMessageFormat.
 * This function performs a deep copy.
 * @param fmt The formatter to copy
 * @param status A pointer to an UErrorCode to receive any errors.
 * @return A pointer to a UDateFormat identical to fmt.
 * @stable ICU 2.0
 */
U_CAPI UMessageFormat U_EXPORT2 
umsg_clone(const UMessageFormat *fmt,
           UErrorCode *status);

/**
 * Sets the locale. This locale is used for fetching default number or date
 * format information.
 * @param fmt The formatter to set
 * @param locale The locale the formatter should use.
 * @stable ICU 2.0
 */
U_CAPI void  U_EXPORT2 
umsg_setLocale(UMessageFormat *fmt,
               const char* locale);

/**
 * Gets the locale. This locale is used for fetching default number or date
 * format information.
 * @param fmt The formatter to querry
 * @return the locale.
 * @stable ICU 2.0
 */
U_CAPI const char*  U_EXPORT2 
umsg_getLocale(const UMessageFormat *fmt);

/**
 * Sets the pattern.
 * @param fmt           The formatter to use
 * @param pattern       The pattern to be applied.
 * @param patternLength Length of the pattern to use
 * @param parseError    Struct to receive information on position 
 *                      of error if an error is encountered.Can be NULL.
 * @param status        Output param set to success/failure code on
 *                      exit. If the pattern is invalid, this will be
 *                      set to a failure result.
 * @stable ICU 2.0
 */
U_CAPI void  U_EXPORT2 
umsg_applyPattern( UMessageFormat *fmt,
                   const UChar* pattern,
                   int32_t patternLength,
                   UParseError* parseError,
                   UErrorCode* status);

/**
 * Gets the pattern.
 * @param fmt          The formatter to use
 * @param result       A pointer to a buffer to receive the pattern.
 * @param resultLength The maximum size of result.
 * @param status       Output param set to success/failure code on
 *                     exit. If the pattern is invalid, this will be
 *                     set to a failure result.  
 * @return the pattern of the format
 * @stable ICU 2.0
 */
U_CAPI int32_t  U_EXPORT2 
umsg_toPattern(const UMessageFormat *fmt,
               UChar* result, 
               int32_t resultLength,
               UErrorCode* status);

/**
 * Format a message for a locale.
 * This function may perform re-ordering of the arguments depending on the
 * locale. For all numeric arguments, double is assumed unless the type is
 * explicitly integer.  All choice format arguments must be of type double.
 * @param fmt           The formatter to use
 * @param result        A pointer to a buffer to receive the formatted message.
 * @param resultLength  The maximum size of result.
 * @param status        A pointer to an UErrorCode to receive any errors
 * @param ...           A variable-length argument list containing the arguments 
 *                      specified in pattern.
 * @return              The total buffer size needed; if greater than resultLength, 
 *                      the output was truncated.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
umsg_format(    const UMessageFormat *fmt,
                UChar          *result,
                int32_t        resultLength,
                UErrorCode     *status,
                ...);

/**
 * Format a message for a locale.
 * This function may perform re-ordering of the arguments depending on the
 * locale. For all numeric arguments, double is assumed unless the type is
 * explicitly integer.  All choice format arguments must be of type double.
 * @param fmt          The formatter to use 
 * @param result       A pointer to a buffer to receive the formatted message.
 * @param resultLength The maximum size of result.
 * @param ap           A variable-length argument list containing the arguments 
 * @param status       A pointer to an UErrorCode to receive any errors
 *                     specified in pattern.
 * @return             The total buffer size needed; if greater than resultLength, 
 *                     the output was truncated.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
umsg_vformat(   const UMessageFormat *fmt,
                UChar          *result,
                int32_t        resultLength,
                va_list        ap,
                UErrorCode     *status);

/**
 * Parse a message.
 * For numeric arguments, this function will always use doubles.  Integer types
 * should not be passed.
 * This function is not able to parse all output from {@link #umsg_format }.
 * @param fmt           The formatter to use 
 * @param source        The text to parse.
 * @param sourceLength  The length of source, or -1 if null-terminated.
 * @param count         Output param to receive number of elements returned.
 * @param status        A pointer to an UErrorCode to receive any errors
 * @param ...           A variable-length argument list containing the arguments
 *                      specified in pattern.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
umsg_parse( const UMessageFormat *fmt,
            const UChar    *source,
            int32_t        sourceLength,
            int32_t        *count,
            UErrorCode     *status,
            ...);

/**
 * Parse a message.
 * For numeric arguments, this function will always use doubles.  Integer types
 * should not be passed.
 * This function is not able to parse all output from {@link #umsg_format }.
 * @param fmt           The formatter to use 
 * @param source        The text to parse.
 * @param sourceLength  The length of source, or -1 if null-terminated.
 * @param count         Output param to receive number of elements returned.
 * @param ap            A variable-length argument list containing the arguments
 * @param status        A pointer to an UErrorCode to receive any errors
 *                      specified in pattern.
 * @see u_formatMessage
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
umsg_vparse(const UMessageFormat *fmt,
            const UChar    *source,
            int32_t        sourceLength,
            int32_t        *count,
            va_list        ap,
            UErrorCode     *status);


/**
 * Convert an 'apostrophe-friendly' pattern into a standard
 * pattern.  Standard patterns treat all apostrophes as
 * quotes, which is problematic in some languages, e.g. 
 * French, where apostrophe is commonly used.  This utility
 * assumes that only an unpaired apostrophe immediately before
 * a brace is a true quote.  Other unpaired apostrophes are paired,
 * and the resulting standard pattern string is returned.
 *
 * <p><b>Note</b> it is not guaranteed that the returned pattern
 * is indeed a valid pattern.  The only effect is to convert
 * between patterns having different quoting semantics.
 *
 * @param pattern the 'apostrophe-friendly' patttern to convert
 * @param patternLength the length of pattern, or -1 if unknown and pattern is null-terminated
 * @param dest the buffer for the result, or NULL if preflight only
 * @param destCapacity the length of the buffer, or 0 if preflighting
 * @param ec the error code
 * @return the length of the resulting text, not including trailing null
 *        if buffer has room for the trailing null, it is provided, otherwise
 *        not
 * @stable ICU 3.4
 */
U_CAPI int32_t U_EXPORT2 
umsg_autoQuoteApostrophe(const UChar* pattern, 
                         int32_t patternLength,
                         UChar* dest,
                         int32_t destCapacity,
                         UErrorCode* ec);

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif
