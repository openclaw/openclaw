// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
*   Copyright (C) 2012-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
********************************************************************************
*
* File COMPACTDECIMALFORMAT.H
********************************************************************************
*/

#ifndef __COMPACT_DECIMAL_FORMAT_H__
#define __COMPACT_DECIMAL_FORMAT_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: Compatibility APIs for compact decimal number formatting.
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/decimfmt.h"

struct UHashtable;

U_NAMESPACE_BEGIN

class PluralRules;

/**
 * **IMPORTANT:** New users are strongly encouraged to see if
 * numberformatter.h fits their use case.  Although not deprecated, this header
 * is provided for backwards compatibility only.
 *
 * -----------------------------------------------------------------------------
 *
 * The CompactDecimalFormat produces abbreviated numbers, suitable for display in
 * environments will limited real estate. For example, 'Hits: 1.2B' instead of
 * 'Hits: 1,200,000,000'. The format will be appropriate for the given language,
 * such as "1,2 Mrd." for German.
 *
 * For numbers under 1000 trillion (under 10^15, such as 123,456,789,012,345),
 * the result will be short for supported languages. However, the result may
 * sometimes exceed 7 characters, such as when there are combining marks or thin
 * characters. In such cases, the visual width in fonts should still be short.
 *
 * By default, there are 3 significant digits. After creation, if more than
 * three significant digits are set (with setMaximumSignificantDigits), or if a
 * fixed number of digits are set (with setMaximumIntegerDigits or
 * setMaximumFractionDigits), then result may be wider.
 *
 * At this time, parsing is not supported, and will produce a U_UNSUPPORTED_ERROR.
 * Resetting the pattern prefixes or suffixes is not supported; the method calls
 * are ignored.
 *
 * @stable ICU 51
 */
class U_I18N_API CompactDecimalFormat : public DecimalFormat {
public:

     /**
      * Returns a compact decimal instance for specified locale.
      *
      * **NOTE:** New users are strongly encouraged to use
      * `number::NumberFormatter` instead of NumberFormat.
      * @param inLocale the given locale.
      * @param style whether to use short or long style.
      * @param status error code returned  here.
      * @stable ICU 51
      */
     static CompactDecimalFormat* U_EXPORT2 createInstance(
          const Locale& inLocale, UNumberCompactStyle style, UErrorCode& status);

    /**
     * Copy constructor.
     *
     * @param source    the DecimalFormat object to be copied from.
     * @stable ICU 51
      */
    CompactDecimalFormat(const CompactDecimalFormat& source);

    /**
     * Destructor.
     * @stable ICU 51
     */
    ~CompactDecimalFormat() override;

    /**
     * Assignment operator.
     *
     * @param rhs    the DecimalFormat object to be copied.
     * @stable ICU 51
     */
    CompactDecimalFormat& operator=(const CompactDecimalFormat& rhs);

    /**
     * Clone this Format object polymorphically. The caller owns the
     * result and should delete it when done.
     *
     * @return    a polymorphic copy of this CompactDecimalFormat.
     * @stable ICU 51
     */
    CompactDecimalFormat* clone() const override;

    using DecimalFormat::format;

    /**
     * CompactDecimalFormat does not support parsing. This implementation
     * does nothing.
     * @param text           Unused.
     * @param result         Does not change.
     * @param parsePosition  Does not change.
     * @see Formattable
     * @stable ICU 51
     */
    void parse(const UnicodeString& text, Formattable& result,
               ParsePosition& parsePosition) const override;

    /**
     * CompactDecimalFormat does not support parsing. This implementation
     * sets status to U_UNSUPPORTED_ERROR
     *
     * @param text      Unused.
     * @param result    Does not change.
     * @param status    Always set to U_UNSUPPORTED_ERROR.
     * @stable ICU 51
     */
    void parse(const UnicodeString& text, Formattable& result, UErrorCode& status) const override;

#ifndef U_HIDE_INTERNAL_API
    /**
     * Parses text from the given string as a currency amount.  Unlike
     * the parse() method, this method will attempt to parse a generic
     * currency name, searching for a match of this object's locale's
     * currency display names, or for a 3-letter ISO currency code.
     * This method will fail if this format is not a currency format,
     * that is, if it does not contain the currency pattern symbol
     * (U+00A4) in its prefix or suffix. This implementation always returns
     * nullptr.
     *
     * @param text the string to parse
     * @param pos  input-output position; on input, the position within text
     *             to match; must have 0 <= pos.getIndex() < text.length();
     *             on output, the position after the last matched character.
     *             If the parse fails, the position in unchanged upon output.
     * @return     if parse succeeds, a pointer to a newly-created CurrencyAmount
     *             object (owned by the caller) containing information about
     *             the parsed currency; if parse fails, this is nullptr.
     * @internal
     */
    CurrencyAmount* parseCurrency(const UnicodeString& text, ParsePosition& pos) const override;
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Return the class ID for this class.  This is useful only for
     * comparing to a return value from getDynamicClassID().  For example:
     * <pre>
     * .      Base* polymorphic_pointer = createPolymorphicObject();
     * .      if (polymorphic_pointer->getDynamicClassID() ==
     * .          Derived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 51
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns a unique class ID POLYMORPHICALLY.  Pure virtual override.
     * This method is to implement a simple version of RTTI, since not all
     * C++ compilers support genuine RTTI.  Polymorphic operator==() and
     * clone() methods call this method.
     *
     * @return          The class ID for this object. All objects of a
     *                  given class have the same class ID.  Objects of
     *                  other classes have different class IDs.
     * @stable ICU 51
     */
    UClassID getDynamicClassID() const override;

  private:
    CompactDecimalFormat(const Locale& inLocale, UNumberCompactStyle style, UErrorCode& status);
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __COMPACT_DECIMAL_FORMAT_H__
//eof
