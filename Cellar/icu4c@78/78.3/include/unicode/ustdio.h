// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*
*   Copyright (C) 1998-2015, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
******************************************************************************
*
* File ustdio.h
*
* Modification History:
*
*   Date        Name        Description
*   10/16/98    stephen     Creation.
*   11/06/98    stephen     Modified per code review.
*   03/12/99    stephen     Modified for new C API.
*   07/19/99    stephen     Minor doc update.
*   02/01/01    george      Added sprintf & sscanf with all of its variants
******************************************************************************
*/

#ifndef USTDIO_H
#define USTDIO_H

#include <stdio.h>
#include <stdarg.h>

#include "unicode/utypes.h"
#include "unicode/ucnv.h"
#include "unicode/utrans.h"
#include "unicode/unum.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_CONVERSION

/*
    TODO
 The following is a small list as to what is currently wrong/suggestions for
 ustdio.

 * Make sure that * in the scanf format specification works for all formats.
 * Each UFILE takes up at least 2KB.
    Look into adding setvbuf() for configurable buffers.
 * This library does buffering. The OS should do this for us already. Check on
    this, and remove it from this library, if this is the case. Double buffering
    wastes a lot of time and space.
 * Test stdin and stdout with the u_f* functions
 * Testing should be done for reading and writing multi-byte encodings,
    and make sure that a character that is contained across buffer boundaries
    works even for incomplete characters.
 * Make sure that the last character is flushed when the file/string is closed.
 * snprintf should follow the C99 standard for the return value, which is
    return the number of characters (excluding the trailing '\0')
    which would have been written to the destination string regardless
    of available space. This is like pre-flighting.
 * Everything that uses %s should do what operator>> does for UnicodeString.
    It should convert one byte at a time, and once a character is
    converted then check to see if it's whitespace or in the scanset.
    If it's whitespace or in the scanset, put all the bytes back (do nothing
    for sprintf/sscanf).
 * If bad string data is encountered, make sure that the function fails
    without memory leaks and the unconvertable characters are valid
    substitution or are escaped characters.
 * u_fungetc() can't unget a character when it's at the beginning of the
    internal conversion buffer. For example, read the buffer size # of
    characters, and then ungetc to get the previous character that was
    at the end of the last buffer.
 * u_fflush() and u_fclose should return an int32_t like C99 functions.
    0 is returned if the operation was successful and EOF otherwise.
 * u_fsettransliterator does not support U_READ side of transliteration.
 * The format specifier should limit the size of a format or honor it in
    order to prevent buffer overruns.  (e.g. %256.256d).
 * u_fread and u_fwrite don't exist. They're needed for reading and writing
    data structures without any conversion.
 * u_file_read and u_file_write are used for writing strings. u_fgets and
    u_fputs or u_fread and u_fwrite should be used to do this.
 * The width parameter for all scanf formats, including scanset, needs
    better testing. This prevents buffer overflows.
 * Figure out what is suppose to happen when a codepage is changed midstream.
    Maybe a flush or a rewind are good enough.
 * Make sure that a UFile opened with "rw" can be used after using
    u_fflush with a u_frewind.
 * scanf(%i) should detect what type of number to use.
 * Add more testing of the alternate format, %#
 * Look at newline handling of fputs/puts
 * Think more about codeunit/codepoint error handling/support in %S,%s,%C,%c,%[]
 * Complete the file documentation with proper doxygen formatting.
    See http://oss.software.ibm.com/pipermail/icu/2003-July/005647.html
*/

/**
 * \file
 * \brief C API: Unicode stdio-like API
 *
 * <h2>Unicode stdio-like C API</h2>
 *
 * <p>This API provides an stdio-like API wrapper around ICU's other
 * formatting and parsing APIs. It is meant to ease the transition of adding
 * Unicode support to a preexisting applications using stdio. The following
 * is a small list of noticeable differences between stdio and ICU I/O's
 * ustdio implementation.</p>
 *
 * <ul>
 * <li>Locale specific formatting and parsing is only done with file IO.</li>
 * <li>u_fstropen can be used to simulate file IO with strings.
 * This is similar to the iostream API, and it allows locale specific
 * formatting and parsing to be used.</li>
 * <li>This API provides uniform formatting and parsing behavior between
 * platforms (unlike the standard stdio implementations found on various
 * platforms).</li>
 * <li>This API is better suited for text data handling than binary data
 * handling when compared to the typical stdio implementation.</li>
 * <li>You can specify a Transliterator while using the file IO.</li>
 * <li>You can specify a file's codepage separately from the default
 * system codepage.</li>
 * </ul>
 *
 * <h2>Formatting and Parsing Specification</h2>
 *
 * General printf format:<br>
 * %[format modifier][width][.precision][type modifier][format]
 * 
 * General scanf format:<br>
 * %[*][format modifier][width][type modifier][format]
 * 
<table cellspacing="3">
<tr><td>format</td><td>default<br>printf<br>type</td><td>default<br>scanf<br>type</td><td>description</td></tr>
<tr><td>%E</td><td>double</td><td>float</td><td>Scientific with an uppercase exponent</td></tr>
<tr><td>%e</td><td>double</td><td>float</td><td>Scientific with a lowercase exponent</td></tr>
<tr><td>%G</td><td>double</td><td>float</td><td>Use %E or %f for best format</td></tr>
<tr><td>%g</td><td>double</td><td>float</td><td>Use %e or %f for best format</td></tr>
<tr><td>%f</td><td>double</td><td>float</td><td>Simple floating point without the exponent</td></tr>
<tr><td>%X</td><td>int32_t</td><td>int32_t</td><td>ustdio special uppercase hex radix formatting</td></tr>
<tr><td>%x</td><td>int32_t</td><td>int32_t</td><td>ustdio special lowercase hex radix formatting</td></tr>
<tr><td>%d</td><td>int32_t</td><td>int32_t</td><td>Decimal format</td></tr>
<tr><td>%i</td><td>int32_t</td><td>int32_t</td><td>Same as %d</td></tr>
<tr><td>%n</td><td>int32_t</td><td>int32_t</td><td>count (write the number of UTF-16 codeunits read/written)</td></tr>
<tr><td>%o</td><td>int32_t</td><td>int32_t</td><td>ustdio special octal radix formatting</td></tr>
<tr><td>%u</td><td>uint32_t</td><td>uint32_t</td><td>Decimal format</td></tr>
<tr><td>%p</td><td>void *</td><td>void *</td><td>Prints the pointer value</td></tr>
<tr><td>%s</td><td>char *</td><td>char *</td><td>Use default converter or specified converter from fopen</td></tr>
<tr><td>%c</td><td>char</td><td>char</td><td>Use default converter or specified converter from fopen<br>
When width is specified for scanf, this acts like a non-NULL-terminated char * string.<br>
By default, only one char is written.</td></tr>
<tr><td>%S</td><td>UChar *</td><td>UChar *</td><td>Null terminated UTF-16 string</td></tr>
<tr><td>%C</td><td>UChar</td><td>UChar</td><td>16-bit Unicode code unit<br>
When width is specified for scanf, this acts like a non-NULL-terminated UChar * string<br>
By default, only one codepoint is written.</td></tr>
<tr><td>%[]</td><td>&nbsp;</td><td>UChar *</td><td>Null terminated UTF-16 string which contains the filtered set of characters specified by the UnicodeSet</td></tr>
<tr><td>%%</td><td>&nbsp;</td><td>&nbsp;</td><td>Show a percent sign</td></tr>
</table>

Format modifiers
<table>
<tr><td>modifier</td><td>formats</td><td>type</td><td>comments</td></tr>
<tr><td>%h</td><td>%d, %i, %o, %x</td><td>int16_t</td><td>short format</td></tr>
<tr><td>%h</td><td>%u</td><td>uint16_t</td><td>short format</td></tr>
<tr><td>%h</td><td>c</td><td>char</td><td><b>(Unimplemented)</b> Use invariant converter</td></tr>
<tr><td>%h</td><td>s</td><td>char *</td><td><b>(Unimplemented)</b> Use invariant converter</td></tr>
<tr><td>%h</td><td>C</td><td>char</td><td><b>(Unimplemented)</b> 8-bit Unicode code unit</td></tr>
<tr><td>%h</td><td>S</td><td>char *</td><td><b>(Unimplemented)</b> Null terminated UTF-8 string</td></tr>
<tr><td>%l</td><td>%d, %i, %o, %x</td><td>int32_t</td><td>long format (no effect)</td></tr>
<tr><td>%l</td><td>%u</td><td>uint32_t</td><td>long format (no effect)</td></tr>
<tr><td>%l</td><td>c</td><td>N/A</td><td><b>(Unimplemented)</b> Reserved for future implementation</td></tr>
<tr><td>%l</td><td>s</td><td>N/A</td><td><b>(Unimplemented)</b> Reserved for future implementation</td></tr>
<tr><td>%l</td><td>C</td><td>UChar32</td><td><b>(Unimplemented)</b> 32-bit Unicode code unit</td></tr>
<tr><td>%l</td><td>S</td><td>UChar32 *</td><td><b>(Unimplemented)</b> Null terminated UTF-32 string</td></tr>
<tr><td>%ll</td><td>%d, %i, %o, %x</td><td>int64_t</td><td>long long format</td></tr>
<tr><td>%ll</td><td>%u</td><td>uint64_t</td><td><b>(Unimplemented)</b> long long format</td></tr>
<tr><td>%-</td><td><i>all</i></td><td>N/A</td><td>Left justify</td></tr>
<tr><td>%+</td><td>%d, %i, %o, %x, %e, %f, %g, %E, %G</td><td>N/A</td><td>Always show the plus or minus sign. Needs data for plus sign.</td></tr>
<tr><td>% </td><td>%d, %i, %o, %x, %e, %f, %g, %E, %G</td><td>N/A</td><td>Instead of a "+" output a blank character for positive numbers.</td></tr>
<tr><td>%#</td><td>%d, %i, %o, %x, %e, %f, %g, %E, %G</td><td>N/A</td><td>Precede octal value with 0, hex with 0x and show the 
                decimal point for floats.</td></tr>
<tr><td>%<i>n</i></td><td><i>all</i></td><td>N/A</td><td>Width of input/output. num is an actual number from 0 to 
                some large number.</td></tr>
<tr><td>%.<i>n</i></td><td>%e, %f, %g, %E, %F, %G</td><td>N/A</td><td>Significant digits precision. num is an actual number from
                0 to some large number.<br>If * is used in printf, then the precision is passed in as an argument before the number to be formatted.</td></tr>
</table>

printf modifier
%*  int32_t     Next argument after this one specifies the width

scanf modifier
%*  N/A         This field is scanned, but not stored

<p>If you are using this C API instead of the ustream.h API for C++,
you can use one of the following u_fprintf examples to display a UnicodeString.</p>

<pre><code>
    UFILE *out = u_finit(stdout, NULL, NULL);
    UnicodeString string1("string 1");
    UnicodeString string2("string 2");
    u_fprintf(out, "%S\n", string1.getTerminatedBuffer());
    u_fprintf(out, "%.*S\n", string2.length(), string2.getBuffer());
    u_fclose(out);
</code></pre>

 */


/**
 * When an end of file is encountered, this value can be returned.
 * @see u_fgetc
 * @stable 3.0
 */
#define U_EOF 0xFFFF

/** Forward declaration of a Unicode-aware file @stable 3.0 */
typedef struct UFILE UFILE;

/**
 * Enum for which direction of stream a transliterator applies to.
 * @see u_fsettransliterator
 * @stable ICU 3.0
 */
typedef enum { 
   U_READ = 1,
   U_WRITE = 2, 
   U_READWRITE =3  /* == (U_READ | U_WRITE) */ 
} UFileDirection;

/**
 * Open a UFILE.
 * A UFILE is a wrapper around a FILE* that is locale and codepage aware.
 * That is, data written to a UFILE will be formatted using the conventions
 * specified by that UFILE's Locale; this data will be in the character set
 * specified by that UFILE's codepage.
 * @param filename The name of the file to open. Must be 0-terminated.
 * @param perm The read/write permission for the UFILE; one of "r", "w", "rw"
 * @param locale The locale whose conventions will be used to format 
 * and parse output. If this parameter is NULL, the default locale will 
 * be used.
 * @param codepage The codepage in which data will be written to and
 * read from the file. If this parameter is NULL the system default codepage
 * will be used.
 * @return A new UFILE, or NULL if an error occurred.
 * @stable ICU 3.0
 */
U_CAPI UFILE* U_EXPORT2
u_fopen(const char    *filename,
    const char    *perm,
    const char    *locale,
    const char    *codepage);

/**
 * Open a UFILE with a UChar* filename
 * A UFILE is a wrapper around a FILE* that is locale and codepage aware.
 * That is, data written to a UFILE will be formatted using the conventions
 * specified by that UFILE's Locale; this data will be in the character set
 * specified by that UFILE's codepage.
 * @param filename The name of the file to open. Must be 0-terminated.
 * @param perm The read/write permission for the UFILE; one of "r", "w", "rw"
 * @param locale The locale whose conventions will be used to format
 * and parse output. If this parameter is NULL, the default locale will
 * be used.
 * @param codepage The codepage in which data will be written to and
 * read from the file. If this parameter is NULL the system default codepage
 * will be used.
 * @return A new UFILE, or NULL if an error occurred.
 * @stable ICU 54
 */
U_CAPI UFILE* U_EXPORT2
u_fopen_u(const UChar    *filename,
    const char    *perm,
    const char    *locale,
    const char    *codepage);

/**
 * Open a UFILE on top of an existing FILE* stream. The FILE* stream
 * ownership remains with the caller. To have the UFILE take over
 * ownership and responsibility for the FILE* stream, use the
 * function u_fadopt.
 * @param f The FILE* to which this UFILE will attach and use.
 * @param locale The locale whose conventions will be used to format 
 * and parse output. If this parameter is NULL, the default locale will 
 * be used.
 * @param codepage The codepage in which data will be written to and
 * read from the file. If this parameter is NULL, data will be written and
 * read using the default codepage for <TT>locale</TT>, unless <TT>locale</TT>
 * is NULL, in which case the system default codepage will be used.
 * @return A new UFILE, or NULL if an error occurred.
 * @stable ICU 3.0
 */
U_CAPI UFILE* U_EXPORT2
u_finit(FILE        *f,
    const char    *locale,
    const char    *codepage);

/**
 * Open a UFILE on top of an existing FILE* stream. The FILE* stream
 * ownership is transferred to the new UFILE. It will be closed when the
 * UFILE is closed.
 * @param f The FILE* which this UFILE will take ownership of.
 * @param locale The locale whose conventions will be used to format
 * and parse output. If this parameter is NULL, the default locale will
 * be used.
 * @param codepage The codepage in which data will be written to and
 * read from the file. If this parameter is NULL, data will be written and
 * read using the default codepage for <TT>locale</TT>, unless <TT>locale</TT>
 * is NULL, in which case the system default codepage will be used.
 * @return A new UFILE, or NULL if an error occurred. If an error occurs
 * the ownership of the FILE* stream remains with the caller.
 * @stable ICU 4.4
 */
U_CAPI UFILE* U_EXPORT2
u_fadopt(FILE     *f,
    const char    *locale,
    const char    *codepage);

/**
 * Create a UFILE that can be used for localized formatting or parsing.
 * The u_sprintf and u_sscanf functions do not read or write numbers for a
 * specific locale. The ustdio.h file functions can be used on this UFILE.
 * The string is usable once u_fclose or u_fflush has been called on the
 * returned UFILE.
 * @param stringBuf The string used for reading or writing.
 * @param capacity The number of code units available for use in stringBuf
 * @param locale The locale whose conventions will be used to format 
 * and parse output. If this parameter is NULL, the default locale will 
 * be used.
 * @return A new UFILE, or NULL if an error occurred.
 * @stable ICU 3.0
 */
U_CAPI UFILE* U_EXPORT2
u_fstropen(UChar      *stringBuf,
           int32_t     capacity,
           const char *locale);

/**
 * Close a UFILE. Implies u_fflush first.
 * @param file The UFILE to close.
 * @stable ICU 3.0
 * @see u_fflush
 */
U_CAPI void U_EXPORT2
u_fclose(UFILE *file);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUFILEPointer
 * "Smart pointer" class, closes a UFILE via u_fclose().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUFILEPointer, UFILE, u_fclose);

U_NAMESPACE_END

#endif

/**
 * Tests if the UFILE is at the end of the file stream.
 * @param f The UFILE from which to read.
 * @return Returns true after the first read operation that attempts to
 * read past the end of the file. It returns false if the current position is
 * not end of file.
 * @stable ICU 3.0
*/
U_CAPI UBool U_EXPORT2
u_feof(UFILE  *f);

/**
 * Flush output of a UFILE. Implies a flush of
 * converter/transliterator state. (That is, a logical break is
 * made in the output stream - for example if a different type of
 * output is desired.)  The underlying OS level file is also flushed.
 * Note that for a stateful encoding, the converter may write additional
 * bytes to return the stream to default state.
 * @param file The UFILE to flush.
 * @stable ICU 3.0
 */
U_CAPI void U_EXPORT2
u_fflush(UFILE *file);

/**
 * Rewind the file pointer to the beginning of the file.
 * @param file The UFILE to rewind.
 * @stable ICU 3.0
 */
U_CAPI void
u_frewind(UFILE *file);

/**
 * Get the FILE* associated with a UFILE.
 * @param f The UFILE
 * @return A FILE*, owned by the UFILE. (The FILE <EM>must not</EM> be modified or closed)
 * @stable ICU 3.0
 */
U_CAPI FILE* U_EXPORT2
u_fgetfile(UFILE *f);

#if !UCONFIG_NO_FORMATTING

/**
 * Get the locale whose conventions are used to format and parse output.
 * This is the same locale passed in the preceding call to<TT>u_fsetlocale</TT>
 * or <TT>u_fopen</TT>.
 * @param file The UFILE to set.
 * @return The locale whose conventions are used to format and parse output.
 * @stable ICU 3.0
 */
U_CAPI const char* U_EXPORT2
u_fgetlocale(UFILE *file);

/**
 * Set the locale whose conventions will be used to format and parse output.
 * @param locale The locale whose conventions will be used to format 
 * and parse output.
 * @param file The UFILE to query.
 * @return NULL if successful, otherwise a negative number.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_fsetlocale(UFILE      *file,
             const char *locale);

#endif

/**
 * Get the codepage in which data is written to and read from the UFILE.
 * This is the same codepage passed in the preceding call to 
 * <TT>u_fsetcodepage</TT> or <TT>u_fopen</TT>.
 * @param file The UFILE to query.
 * @return The codepage in which data is written to and read from the UFILE,
 * or NULL if an error occurred.
 * @stable ICU 3.0
 */
U_CAPI const char* U_EXPORT2
u_fgetcodepage(UFILE *file);

/**
 * Set the codepage in which data will be written to and read from the UFILE.
 * All Unicode data written to the UFILE will be converted to this codepage
 * before it is written to the underlying FILE*. It it generally a bad idea to
 * mix codepages within a file. This should only be called right
 * after opening the <TT>UFile</TT>, or after calling <TT>u_frewind</TT>.
 * @param codepage The codepage in which data will be written to 
 * and read from the file. For example <TT>"latin-1"</TT> or <TT>"ibm-943"</TT>.
 * A value of NULL means the default codepage for the UFILE's current 
 * locale will be used.
 * @param file The UFILE to set.
 * @return 0 if successful, otherwise a negative number.
 * @see u_frewind
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_fsetcodepage(const char   *codepage,
               UFILE        *file);


/**
 * Returns an alias to the converter being used for this file.
 * @param f The UFILE to get the value from
 * @return alias to the converter (The converter <EM>must not</EM> be modified or closed)
 * @stable ICU 3.0
 */
U_CAPI UConverter* U_EXPORT2 u_fgetConverter(UFILE *f);

#if !UCONFIG_NO_FORMATTING
/**
 * Returns an alias to the number formatter being used for this file.
 * @param f The UFILE to get the value from
 * @return alias to the number formatter (The formatter <EM>must not</EM> be modified or closed)
 * @stable ICU 51
*/
 U_CAPI const UNumberFormat* U_EXPORT2 u_fgetNumberFormat(UFILE *f);

/* Output functions */

/**
 * Write formatted data to <TT>stdout</TT>.
 * @param patternSpecification A pattern specifying how <TT>u_printf</TT> will
 * interpret the variable arguments received and format the data.
 * @return The number of Unicode characters written to <TT>stdout</TT>
 * @stable ICU 49
 */
U_CAPI int32_t U_EXPORT2
u_printf(const char *patternSpecification,
         ... );

/**
 * Write formatted data to a UFILE.
 * @param f The UFILE to which to write.
 * @param patternSpecification A pattern specifying how <TT>u_fprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @return The number of Unicode characters written to <TT>f</TT>.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_fprintf(UFILE         *f,
          const char    *patternSpecification,
          ... );

/**
 * Write formatted data to a UFILE.
 * This is identical to <TT>u_fprintf</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 * @param f The UFILE to which to write.
 * @param patternSpecification A pattern specifying how <TT>u_fprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @param ap The argument list to use.
 * @return The number of Unicode characters written to <TT>f</TT>.
 * @see u_fprintf
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vfprintf(UFILE        *f,
           const char   *patternSpecification,
           va_list      ap);

/**
 * Write formatted data to <TT>stdout</TT>.
 * @param patternSpecification A pattern specifying how <TT>u_printf_u</TT> will
 * interpret the variable arguments received and format the data.
 * @return The number of Unicode characters written to <TT>stdout</TT>
 * @stable ICU 49
 */
U_CAPI int32_t U_EXPORT2
u_printf_u(const UChar *patternSpecification,
           ... );

/**
 * Get a UFILE for <TT>stdout</TT>.
 * @return UFILE that writes to <TT>stdout</TT>
 * @stable ICU 49
 */
U_CAPI UFILE * U_EXPORT2
u_get_stdout(void);

/**
 * Write formatted data to a UFILE.
 * @param f The UFILE to which to write.
 * @param patternSpecification A pattern specifying how <TT>u_fprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @return The number of Unicode characters written to <TT>f</TT>.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_fprintf_u(UFILE       *f,
            const UChar *patternSpecification,
            ... );

/**
 * Write formatted data to a UFILE.
 * This is identical to <TT>u_fprintf_u</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 * @param f The UFILE to which to write.
 * @param patternSpecification A pattern specifying how <TT>u_fprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @param ap The argument list to use.
 * @return The number of Unicode characters written to <TT>f</TT>.
 * @see u_fprintf_u
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vfprintf_u(UFILE      *f,
            const UChar *patternSpecification,
            va_list     ap);
#endif
/**
 * Write a Unicode to a UFILE.  The null (U+0000) terminated UChar*
 * <TT>s</TT> will be written to <TT>f</TT>, excluding the NULL terminator.
 * A newline will be added to <TT>f</TT>.
 * @param s The UChar* to write.
 * @param f The UFILE to which to write.
 * @return A non-negative number if successful, EOF otherwise.
 * @see u_file_write
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_fputs(const UChar *s,
        UFILE       *f);

/**
 * Write a UChar to a UFILE.
 * @param uc The UChar to write.
 * @param f The UFILE to which to write.
 * @return The character written if successful, EOF otherwise.
 * @stable ICU 3.0
 */
U_CAPI UChar32 U_EXPORT2
u_fputc(UChar32  uc,
        UFILE  *f);

/**
 * Write Unicode to a UFILE.
 * The ustring passed in will be converted to the UFILE's underlying
 * codepage before it is written.
 * @param ustring A pointer to the Unicode data to write.
 * @param count The number of Unicode characters to write
 * @param f The UFILE to which to write.
 * @return The number of Unicode characters written.
 * @see u_fputs
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_file_write(const UChar    *ustring, 
             int32_t        count, 
             UFILE          *f);


/* Input functions */
#if !UCONFIG_NO_FORMATTING

/**
 * Read formatted data from a UFILE.
 * @param f The UFILE from which to read.
 * @param patternSpecification A pattern specifying how <TT>u_fscanf</TT> will
 * interpret the variable arguments received and parse the data.
 * @return The number of items successfully converted and assigned, or EOF
 * if an error occurred.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_fscanf(UFILE      *f,
         const char *patternSpecification,
         ... );

/**
 * Read formatted data from a UFILE.
 * This is identical to <TT>u_fscanf</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 * @param f The UFILE from which to read.
 * @param patternSpecification A pattern specifying how <TT>u_fscanf</TT> will
 * interpret the variable arguments received and parse the data.
 * @param ap The argument list to use.
 * @return The number of items successfully converted and assigned, or EOF
 * if an error occurred.
 * @see u_fscanf
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vfscanf(UFILE         *f,
          const char    *patternSpecification,
          va_list        ap);

/**
 * Read formatted data from a UFILE.
 * @param f The UFILE from which to read.
 * @param patternSpecification A pattern specifying how <TT>u_fscanf</TT> will
 * interpret the variable arguments received and parse the data.
 * @return The number of items successfully converted and assigned, or EOF
 * if an error occurred.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_fscanf_u(UFILE        *f,
           const UChar  *patternSpecification,
           ... );

/**
 * Read formatted data from a UFILE.
 * This is identical to <TT>u_fscanf_u</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 * @param f The UFILE from which to read.
 * @param patternSpecification A pattern specifying how <TT>u_fscanf</TT> will
 * interpret the variable arguments received and parse the data.
 * @param ap The argument list to use.
 * @return The number of items successfully converted and assigned, or EOF
 * if an error occurred.
 * @see u_fscanf_u
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vfscanf_u(UFILE       *f,
            const UChar *patternSpecification,
            va_list      ap);
#endif

/**
 * Read one line of text into a UChar* string from a UFILE. The newline
 * at the end of the line is read into the string. The string is always
 * null terminated
 * @param f The UFILE from which to read.
 * @param n The maximum number of characters - 1 to read.
 * @param s The UChar* to receive the read data.  Characters will be
 * stored successively in <TT>s</TT> until a newline or EOF is
 * reached. A null character (U+0000) will be appended to <TT>s</TT>.
 * @return A pointer to <TT>s</TT>, or NULL if no characters were available.
 * @stable ICU 3.0
 */
U_CAPI UChar* U_EXPORT2
u_fgets(UChar  *s,
        int32_t n,
        UFILE  *f);

/**
 * Read a UChar from a UFILE. It is recommended that <TT>u_fgetcx</TT>
 * used instead for proper parsing functions, but sometimes reading
 * code units is needed instead of codepoints.
 *
 * @param f The UFILE from which to read.
 * @return The UChar value read, or U+FFFF if no character was available.
 * @stable ICU 3.0
 */
U_CAPI UChar U_EXPORT2
u_fgetc(UFILE   *f);

/**
 * Read a UChar32 from a UFILE.
 *
 * @param f The UFILE from which to read.
 * @return The UChar32 value read, or U_EOF if no character was
 * available, or U+FFFD (replacement character) if an ill-formed
 * character was encountered.
 * @see u_unescape()
 * @stable ICU 3.0
 */
U_CAPI UChar32 U_EXPORT2
u_fgetcx(UFILE  *f);

/**
 * Unget a UChar from a UFILE.
 * If this function is not the first to operate on <TT>f</TT> after a call
 * to <TT>u_fgetc</TT>, the results are undefined.
 * If this function is passed a character that was not received from the
 * previous <TT>u_fgetc</TT> or <TT>u_fgetcx</TT> call, the results are undefined.
 * @param c The UChar to put back on the stream.
 * @param f The UFILE to receive <TT>c</TT>.
 * @return The UChar32 value put back if successful, U_EOF otherwise.
 * @stable ICU 3.0
 */
U_CAPI UChar32 U_EXPORT2
u_fungetc(UChar32   c,
      UFILE        *f);

/**
 * Read Unicode from a UFILE.
 * Bytes will be converted from the UFILE's underlying codepage, with
 * subsequent conversion to Unicode. The data will not be NULL terminated.
 * @param chars A pointer to receive the Unicode data.
 * @param count The number of Unicode characters to read.
 * @param f The UFILE from which to read.
 * @return The number of Unicode characters read.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_file_read(UChar        *chars, 
        int32_t        count, 
        UFILE         *f);

#if !UCONFIG_NO_TRANSLITERATION

/**
 * Set a transliterator on the UFILE. The transliterator will be owned by the
 * UFILE. 
 * @param file The UFILE to set transliteration on
 * @param adopt The UTransliterator to set. Can be NULL, which will
 * mean that no transliteration is used.
 * @param direction either U_READ, U_WRITE, or U_READWRITE - sets
 *  which direction the transliterator is to be applied to. If
 * U_READWRITE, the "Read" transliteration will be in the inverse
 * direction.
 * @param status ICU error code.
 * @return The previously set transliterator, owned by the
 * caller. If U_READWRITE is specified, only the WRITE transliterator
 * is returned. In most cases, the caller should call utrans_close()
 * on the result of this function.
 * @stable ICU 3.0
 */
U_CAPI UTransliterator* U_EXPORT2
u_fsettransliterator(UFILE *file, UFileDirection direction,
                     UTransliterator *adopt, UErrorCode *status);

#endif


/* Output string functions */
#if !UCONFIG_NO_FORMATTING


/**
 * Write formatted data to a Unicode string.
 *
 * @param buffer The Unicode String to which to write.
 * @param patternSpecification A pattern specifying how <TT>u_sprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @return The number of Unicode code units written to <TT>buffer</TT>. This
 * does not include the terminating null character.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_sprintf(UChar       *buffer,
        const char    *patternSpecification,
        ... );

/**
 * Write formatted data to a Unicode string. When the number of code units
 * required to store the data exceeds <TT>count</TT>, then <TT>count</TT> code
 * units of data are stored in <TT>buffer</TT> and a negative value is
 * returned. When the number of code units required to store the data equals
 * <TT>count</TT>, the string is not null terminated and <TT>count</TT> is
 * returned.
 *
 * @param buffer The Unicode String to which to write.
 * @param count The number of code units to read.
 * @param patternSpecification A pattern specifying how <TT>u_sprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @return The number of Unicode characters that would have been written to
 * <TT>buffer</TT> had count been sufficiently large. This does not include
 * the terminating null character.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_snprintf(UChar      *buffer,
        int32_t       count,
        const char    *patternSpecification,
        ... );

/**
 * Write formatted data to a Unicode string.
 * This is identical to <TT>u_sprintf</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 *
 * @param buffer The Unicode string to which to write.
 * @param patternSpecification A pattern specifying how <TT>u_sprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @param ap The argument list to use.
 * @return The number of Unicode characters written to <TT>buffer</TT>.
 * @see u_sprintf
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vsprintf(UChar      *buffer,
        const char    *patternSpecification,
        va_list        ap);

/**
 * Write formatted data to a Unicode string.
 * This is identical to <TT>u_snprintf</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.<br><br>
 * When the number of code units required to store the data exceeds
 * <TT>count</TT>, then <TT>count</TT> code units of data are stored in
 * <TT>buffer</TT> and a negative value is returned. When the number of code
 * units required to store the data equals <TT>count</TT>, the string is not
 * null terminated and <TT>count</TT> is returned.
 *
 * @param buffer The Unicode string to which to write.
 * @param count The number of code units to read.
 * @param patternSpecification A pattern specifying how <TT>u_sprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @param ap The argument list to use.
 * @return The number of Unicode characters that would have been written to
 * <TT>buffer</TT> had count been sufficiently large.
 * @see u_sprintf
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vsnprintf(UChar     *buffer,
        int32_t       count,
        const char    *patternSpecification,
        va_list        ap);

/**
 * Write formatted data to a Unicode string.
 *
 * @param buffer The Unicode string to which to write.
 * @param patternSpecification A pattern specifying how <TT>u_sprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @return The number of Unicode characters written to <TT>buffer</TT>.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_sprintf_u(UChar      *buffer,
        const UChar    *patternSpecification,
        ... );

/**
 * Write formatted data to a Unicode string. When the number of code units
 * required to store the data exceeds <TT>count</TT>, then <TT>count</TT> code
 * units of data are stored in <TT>buffer</TT> and a negative value is
 * returned. When the number of code units required to store the data equals
 * <TT>count</TT>, the string is not null terminated and <TT>count</TT> is
 * returned.
 *
 * @param buffer The Unicode string to which to write.
 * @param count The number of code units to read.
 * @param patternSpecification A pattern specifying how <TT>u_sprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @return The number of Unicode characters that would have been written to
 * <TT>buffer</TT> had count been sufficiently large.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_snprintf_u(UChar     *buffer,
        int32_t        count,
        const UChar    *patternSpecification,
        ... );

/**
 * Write formatted data to a Unicode string.
 * This is identical to <TT>u_sprintf_u</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 *
 * @param buffer The Unicode string to which to write.
 * @param patternSpecification A pattern specifying how <TT>u_sprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @param ap The argument list to use.
 * @return The number of Unicode characters written to <TT>f</TT>.
 * @see u_sprintf_u
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vsprintf_u(UChar     *buffer,
        const UChar    *patternSpecification,
        va_list        ap);

/**
 * Write formatted data to a Unicode string.
 * This is identical to <TT>u_snprintf_u</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 * When the number of code units required to store the data exceeds
 * <TT>count</TT>, then <TT>count</TT> code units of data are stored in
 * <TT>buffer</TT> and a negative value is returned. When the number of code
 * units required to store the data equals <TT>count</TT>, the string is not
 * null terminated and <TT>count</TT> is returned.
 *
 * @param buffer The Unicode string to which to write.
 * @param count The number of code units to read.
 * @param patternSpecification A pattern specifying how <TT>u_sprintf</TT> will
 * interpret the variable arguments received and format the data.
 * @param ap The argument list to use.
 * @return The number of Unicode characters that would have been written to
 * <TT>f</TT> had count been sufficiently large.
 * @see u_sprintf_u
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vsnprintf_u(UChar *buffer,
        int32_t         count,
        const UChar     *patternSpecification,
        va_list         ap);

/* Input string functions */

/**
 * Read formatted data from a Unicode string.
 *
 * @param buffer The Unicode string from which to read.
 * @param patternSpecification A pattern specifying how <TT>u_sscanf</TT> will
 * interpret the variable arguments received and parse the data.
 * @return The number of items successfully converted and assigned, or EOF
 * if an error occurred.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_sscanf(const UChar   *buffer,
        const char     *patternSpecification,
        ... );

/**
 * Read formatted data from a Unicode string.
 * This is identical to <TT>u_sscanf</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 *
 * @param buffer The Unicode string from which to read.
 * @param patternSpecification A pattern specifying how <TT>u_sscanf</TT> will
 * interpret the variable arguments received and parse the data.
 * @param ap The argument list to use.
 * @return The number of items successfully converted and assigned, or EOF
 * if an error occurred.
 * @see u_sscanf
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vsscanf(const UChar  *buffer,
        const char     *patternSpecification,
        va_list        ap);

/**
 * Read formatted data from a Unicode string.
 *
 * @param buffer The Unicode string from which to read.
 * @param patternSpecification A pattern specifying how <TT>u_sscanf</TT> will
 * interpret the variable arguments received and parse the data.
 * @return The number of items successfully converted and assigned, or EOF
 * if an error occurred.
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_sscanf_u(const UChar  *buffer,
        const UChar     *patternSpecification,
        ... );

/**
 * Read formatted data from a Unicode string.
 * This is identical to <TT>u_sscanf_u</TT>, except that it will
 * <EM>not</EM> call <TT>va_start</TT> and <TT>va_end</TT>.
 *
 * @param buffer The Unicode string from which to read.
 * @param patternSpecification A pattern specifying how <TT>u_sscanf</TT> will
 * interpret the variable arguments received and parse the data.
 * @param ap The argument list to use.
 * @return The number of items successfully converted and assigned, or EOF
 * if an error occurred.
 * @see u_sscanf_u
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
u_vsscanf_u(const UChar *buffer,
        const UChar     *patternSpecification,
        va_list         ap);


#endif
#endif
#endif


