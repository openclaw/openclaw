// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
* Copyright (C) 1997-2011, International Business Machines Corporation and others.
* All Rights Reserved.
********************************************************************************
*
* File FORMAT.H
*
* Modification History:
*
*   Date        Name        Description
*   02/19/97    aliu        Converted from java.
*   03/17/97    clhuang     Updated per C++ implementation.
*   03/27/97    helena      Updated to pass the simple test after code review.
********************************************************************************
*/
// *****************************************************************************
// This file was generated from the java source file Format.java
// *****************************************************************************

#ifndef FORMAT_H
#define FORMAT_H


#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: Base class for all formats. 
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/unistr.h"
#include "unicode/fmtable.h"
#include "unicode/fieldpos.h"
#include "unicode/fpositer.h"
#include "unicode/parsepos.h"
#include "unicode/parseerr.h" 
#include "unicode/locid.h"

U_NAMESPACE_BEGIN

/**
 * Base class for all formats.  This is an abstract base class which
 * specifies the protocol for classes which convert other objects or
 * values, such as numeric values and dates, and their string
 * representations.  In some cases these representations may be
 * localized or contain localized characters or strings.  For example,
 * a numeric formatter such as DecimalFormat may convert a numeric
 * value such as 12345 to the string "$12,345".  It may also parse
 * the string back into a numeric value.  A date and time formatter
 * like SimpleDateFormat may represent a specific date, encoded
 * numerically, as a string such as "Wednesday, February 26, 1997 AD".
 * <P>
 * Many of the concrete subclasses of Format employ the notion of
 * a pattern.  A pattern is a string representation of the rules which
 * govern the interconversion between values and strings.  For example,
 * a DecimalFormat object may be associated with the pattern
 * "$#,##0.00;($#,##0.00)", which is a common US English format for
 * currency values, yielding strings such as "$1,234.45" for 1234.45,
 * and "($987.65)" for 987.6543.  The specific syntax of a pattern
 * is defined by each subclass.
 * <P>
 * Even though many subclasses use patterns, the notion of a pattern
 * is not inherent to Format classes in general, and is not part of
 * the explicit base class protocol.
 * <P>
 * Two complex formatting classes bear mentioning.  These are
 * MessageFormat and ChoiceFormat.  ChoiceFormat is a subclass of
 * NumberFormat which allows the user to format different number ranges
 * as strings.  For instance, 0 may be represented as "no files", 1 as
 * "one file", and any number greater than 1 as "many files".
 * MessageFormat is a formatter which utilizes other Format objects to
 * format a string containing with multiple values.  For instance,
 * A MessageFormat object might produce the string "There are no files
 * on the disk MyDisk on February 27, 1997." given the arguments 0,
 * "MyDisk", and the date value of 2/27/97.  See the ChoiceFormat
 * and MessageFormat headers for further information.
 * <P>
 * If formatting is unsuccessful, a failing UErrorCode is returned when
 * the Format cannot format the type of object, otherwise if there is
 * something illformed about the Unicode replacement character
 * 0xFFFD is returned.
 * <P>
 * If there is no match when parsing, a parse failure UErrorCode is
 * returned for methods which take no ParsePosition.  For the method
 * that takes a ParsePosition, the index parameter is left unchanged.
 * <P>
 * <em>User subclasses are not supported.</em> While clients may write
 * subclasses, such code will not necessarily work and will not be
 * guaranteed to work stably from release to release.
 */
class U_I18N_API_CLASS Format : public UObject {
public:

    /** Destructor
     * @stable ICU 2.4
     */
    U_I18N_API virtual ~Format();

    /**
     * Return true if the given Format objects are semantically equal.
     * Objects of different subclasses are considered unequal.
     * @param other    the object to be compared with.
     * @return         Return true if the given Format objects are semantically equal.
     *                 Objects of different subclasses are considered unequal.
     * @stable ICU 2.0
     */
    U_I18N_API virtual bool operator==(const Format& other) const = 0;

    /**
     * Return true if the given Format objects are not semantically
     * equal.
     * @param other    the object to be compared with.
     * @return         Return true if the given Format objects are not semantically.
     * @stable ICU 2.0
     */
    U_I18N_API bool operator!=(const Format& other) const { return !operator==(other); }

    /**
     * Clone this object polymorphically.  The caller is responsible
     * for deleting the result when done.
     * @return    A copy of the object
     * @stable ICU 2.0
     */
    U_I18N_API virtual Format* clone() const = 0;

    /**
     * Formats an object to produce a string.
     *
     * @param obj       The object to format.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param status    Output parameter filled in with success or failure status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API UnicodeString& format(const Formattable& obj,
                                     UnicodeString& appendTo,
                                     UErrorCode& status) const;

    /**
     * Format an object to produce a string.  This is a pure virtual method which
     * subclasses must implement. This method allows polymorphic formatting
     * of Formattable objects. If a subclass of Format receives a Formattable
     * object type it doesn't handle (e.g., if a numeric Formattable is passed
     * to a DateFormat object) then it returns a failing UErrorCode.
     *
     * @param obj       The object to format.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param pos       On input: an alignment field, if desired.
     *                  On output: the offsets of the alignment field.
     * @param status    Output param filled with success/failure status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UnicodeString& format(const Formattable& obj,
                                             UnicodeString& appendTo,
                                             FieldPosition& pos,
                                             UErrorCode& status) const = 0;

    /**
     * Format an object to produce a string.  Subclasses should override this
     * method. This method allows polymorphic formatting of Formattable objects.
     * If a subclass of Format receives a Formattable object type it doesn't
     * handle (e.g., if a numeric Formattable is passed to a DateFormat object)
     * then it returns a failing UErrorCode.
     *
     * @param obj       The object to format.
     * @param appendTo  Output parameter to receive result.
     *                  Result is appended to existing contents.
     * @param posIter   On return, can be used to iterate over positions
     *                  of fields generated by this format call.
     * @param status    Output param filled with success/failure status.
     * @return          Reference to 'appendTo' parameter.
     * @stable ICU 4.4
     */
    U_I18N_API virtual UnicodeString& format(const Formattable& obj,
                                             UnicodeString& appendTo,
                                             FieldPositionIterator* posIter,
                                             UErrorCode& status) const;

    /**
     * Parse a string to produce an object.  This is a pure virtual
     * method which subclasses must implement.  This method allows
     * polymorphic parsing of strings into Formattable objects.
     * <P>
     * Before calling, set parse_pos.index to the offset you want to
     * start parsing at in the source.  After calling, parse_pos.index
     * is the end of the text you parsed.  If error occurs, index is
     * unchanged.
     * <P>
     * When parsing, leading whitespace is discarded (with successful
     * parse), while trailing whitespace is left as is.
     * <P>
     * Example:
     * <P>
     * Parsing "_12_xy" (where _ represents a space) for a number,
     * with index == 0 will result in the number 12, with
     * parse_pos.index updated to 3 (just before the second space).
     * Parsing a second time will result in a failing UErrorCode since
     * "xy" is not a number, and leave index at 3.
     * <P>
     * Subclasses will typically supply specific parse methods that
     * return different types of values. Since methods can't overload
     * on return types, these will typically be named "parse", while
     * this polymorphic method will always be called parseObject.  Any
     * parse method that does not take a parse_pos should set status
     * to an error value when no text in the required format is at the
     * start position.
     *
     * @param source    The string to be parsed into an object.
     * @param result    Formattable to be set to the parse result.
     *                  If parse fails, return contents are undefined.
     * @param parse_pos The position to start parsing at. Upon return
     *                  this param is set to the position after the
     *                  last character successfully parsed. If the
     *                  source is not parsed successfully, this param
     *                  will remain unchanged.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void parseObject(const UnicodeString& source,
                                        Formattable& result,
                                        ParsePosition& parse_pos) const = 0;

    /**
     * Parses a string to produce an object. This is a convenience method
     * which calls the pure virtual parseObject() method, and returns a
     * failure UErrorCode if the ParsePosition indicates failure.
     *
     * @param source    The string to be parsed into an object.
     * @param result    Formattable to be set to the parse result.
     *                  If parse fails, return contents are undefined.
     * @param status    Output param to be filled with success/failure
     *                  result code.
     * @stable ICU 2.0
     */
    U_I18N_API void parseObject(const UnicodeString& source,
                                Formattable& result,
                                UErrorCode& status) const;

    /** Get the locale for this format object. You can choose between valid and actual locale.
     *  @param type type of the locale we're looking for (valid or actual) 
     *  @param status error code for the operation
     *  @return the locale
     *  @stable ICU 2.8
     */
    U_I18N_API Locale getLocale(ULocDataLocaleType type, UErrorCode& status) const;

#ifndef U_HIDE_INTERNAL_API
    /** Get the locale for this format object. You can choose between valid and actual locale.
     *  @param type type of the locale we're looking for (valid or actual) 
     *  @param status error code for the operation
     *  @return the locale
     *  @internal
     */
    U_I18N_API const char* getLocaleID(ULocDataLocaleType type, UErrorCode& status) const;
#endif  /* U_HIDE_INTERNAL_API */

 protected:
    /** @stable ICU 2.8 */
    U_I18N_API void setLocaleIDs(const char* valid, const char* actual);

protected:
    /**
     * Default constructor for subclass use only.  Does nothing.
     * @stable ICU 2.0
     */
    U_I18N_API Format();

    /**
     * @stable ICU 2.0
     */
    U_I18N_API Format(const Format&); // Does nothing; for subclasses only

    /**
     * @stable ICU 2.0
     */
    U_I18N_API Format& operator=(const Format&); // Does nothing; for subclasses

    /**
     * Simple function for initializing a UParseError from a UnicodeString.
     *
     * @param pattern The pattern to copy into the parseError
     * @param pos The position in pattern where the error occurred
     * @param parseError The UParseError object to fill in
     * @stable ICU 2.4
     */
    U_I18N_API static void syntaxError(const UnicodeString& pattern,
                                       int32_t pos,
                                       UParseError& parseError);

 private:
    Locale actualLocale;
    Locale validLocale;
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _FORMAT
//eof
