// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*
*   Copyright (C) 2012-2016, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
*******************************************************************************
*   file name:  listformatter.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 20120426
*   created by: Umesh P. Nair
*/

#ifndef __LISTFORMATTER_H__
#define __LISTFORMATTER_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/unistr.h"
#include "unicode/locid.h"
#include "unicode/formattedvalue.h"
#include "unicode/ulistformatter.h"

U_NAMESPACE_BEGIN

class FieldPositionHandler;
class FormattedListData;
class ListFormatter;

/** @internal */
class Hashtable;

/** @internal */
struct ListFormatInternal;

/* The following can't be #ifndef U_HIDE_INTERNAL_API, needed for other .h file declarations */
/**
 * @internal
 * \cond
 */
struct ListFormatData : public UMemory {
    UnicodeString twoPattern;
    UnicodeString startPattern;
    UnicodeString middlePattern;
    UnicodeString endPattern;
    Locale locale;

  ListFormatData(const UnicodeString& two, const UnicodeString& start, const UnicodeString& middle, const UnicodeString& end,
                 const Locale& loc) :
      twoPattern(two), startPattern(start), middlePattern(middle), endPattern(end), locale(loc) {}
};
/** \endcond */


/**
 * \file
 * \brief C++ API: API for formatting a list.
 */


/**
 * An immutable class containing the result of a list formatting operation.
 *
 * Instances of this class are immutable and thread-safe.
 *
 * When calling nextPosition():
 * The fields are returned from start to end. The special field category
 * UFIELD_CATEGORY_LIST_SPAN is used to indicate which argument
 * was inserted at the given position. The span category will
 * always occur before the corresponding instance of UFIELD_CATEGORY_LIST
 * in the nextPosition() iterator.
 *
 * Not intended for public subclassing.
 *
 * @stable ICU 64
 */
class U_I18N_API FormattedList : public UMemory, public FormattedValue {
  public:
    /**
     * Default constructor; makes an empty FormattedList.
     * @stable ICU 64
     */
    FormattedList() : fData(nullptr), fErrorCode(U_INVALID_STATE_ERROR) {}

    /**
     * Move constructor: Leaves the source FormattedList in an undefined state.
     * @stable ICU 64
     */
    FormattedList(FormattedList&& src) noexcept;

    /**
     * Destruct an instance of FormattedList.
     * @stable ICU 64
     */
    virtual ~FormattedList() override;

    /** Copying not supported; use move constructor instead. */
    FormattedList(const FormattedList&) = delete;

    /** Copying not supported; use move assignment instead. */
    FormattedList& operator=(const FormattedList&) = delete;

    /**
     * Move assignment: Leaves the source FormattedList in an undefined state.
     * @stable ICU 64
     */
    FormattedList& operator=(FormattedList&& src) noexcept;

    /** @copydoc FormattedValue::toString() */
    UnicodeString toString(UErrorCode& status) const override;

    /** @copydoc FormattedValue::toTempString() */
    UnicodeString toTempString(UErrorCode& status) const override;

    /** @copydoc FormattedValue::appendTo() */
    Appendable &appendTo(Appendable& appendable, UErrorCode& status) const override;

    /** @copydoc FormattedValue::nextPosition() */
    UBool nextPosition(ConstrainedFieldPosition& cfpos, UErrorCode& status) const override;

  private:
    FormattedListData *fData;
    UErrorCode fErrorCode;
    explicit FormattedList(FormattedListData *results)
        : fData(results), fErrorCode(U_ZERO_ERROR) {}
    explicit FormattedList(UErrorCode errorCode)
        : fData(nullptr), fErrorCode(errorCode) {}
    friend class ListFormatter;
};


/**
 * An immutable class for formatting a list, using data from CLDR (or supplied
 * separately).
 *
 * Example: Input data ["Alice", "Bob", "Charlie", "Delta"] will be formatted
 * as "Alice, Bob, Charlie and Delta" in English.
 *
 * The ListFormatter class is not intended for public subclassing.
 * @stable ICU 50
 */
class U_I18N_API ListFormatter : public UObject{

  public:

    /**
     * Copy constructor.
     * @stable ICU 52
     */
    ListFormatter(const ListFormatter&);

    /**
     * Assignment operator.
     * @stable ICU 52
     */
    ListFormatter& operator=(const ListFormatter& other);

    /**
     * Creates a ListFormatter appropriate for the default locale.
     *
     * @param errorCode ICU error code, set if no data available for default locale.
     * @return Pointer to a ListFormatter object for the default locale,
     *     created from internal data derived from CLDR data.
     * @stable ICU 50
     */
    static ListFormatter* createInstance(UErrorCode& errorCode);

    /**
     * Creates a ListFormatter appropriate for a locale.
     *
     * @param locale The locale.
     * @param errorCode ICU error code, set if no data available for the given locale.
     * @return A ListFormatter object created from internal data derived from
     *     CLDR data.
     * @stable ICU 50
     */
    static ListFormatter* createInstance(const Locale& locale, UErrorCode& errorCode);

    /**
     * Creates a ListFormatter for the given locale, list type, and style.
     *
     * @param locale The locale.
     * @param type The type of list formatting to use.
     * @param width The width of formatting to use.
     * @param errorCode ICU error code, set if no data available for the given locale.
     * @return A ListFormatter object created from internal data derived from CLDR data.
     * @stable ICU 67
     */
    static ListFormatter* createInstance(
      const Locale& locale, UListFormatterType type, UListFormatterWidth width, UErrorCode& errorCode);

    /**
     * Destructor.
     *
     * @stable ICU 50
     */
    virtual ~ListFormatter();


    /**
     * Formats a list of strings.
     *
     * @param items An array of strings to be combined and formatted.
     * @param n_items Length of the array items.
     * @param appendTo The string to which the result should be appended to.
     * @param errorCode ICU error code, set if there is an error.
     * @return Formatted string combining the elements of items, appended to appendTo.
     * @stable ICU 50
     */
    UnicodeString& format(const UnicodeString items[], int32_t n_items,
        UnicodeString& appendTo, UErrorCode& errorCode) const;

    /**
     * Formats a list of strings to a FormattedList, which exposes field
     * position information. The FormattedList contains more information than
     * a FieldPositionIterator.
     *
     * @param items     An array of strings to be combined and formatted.
     * @param n_items   Length of the array items.
     * @param errorCode ICU error code returned here.
     * @return          A FormattedList containing field information.
     * @stable ICU 64
     */
    FormattedList formatStringsToValue(
        const UnicodeString items[],
        int32_t n_items,
        UErrorCode& errorCode) const;

#ifndef U_HIDE_INTERNAL_API
    /**
      @internal for MeasureFormat
    */
    UnicodeString& format(
            const UnicodeString items[],
            int32_t n_items,
            UnicodeString& appendTo,
            int32_t index,
            int32_t &offset,
            UErrorCode& errorCode) const;
    /**
     * @internal constructor made public for testing.
     */
    ListFormatter(const ListFormatData &data, UErrorCode &errorCode);
    /**
     * @internal constructor made public for testing.
     */
    ListFormatter(const ListFormatInternal* listFormatterInternal);
#endif  /* U_HIDE_INTERNAL_API */

  private:
  
    /**
     * Creates a ListFormatter appropriate for a locale and style.
     *
     * @param locale The locale.
     * @param style the style, either "standard", "or", "unit", "unit-narrow", or "unit-short"
     */
    static ListFormatter* createInstance(const Locale& locale, const char* style, UErrorCode& errorCode);

    static void initializeHash(UErrorCode& errorCode);
    static const ListFormatInternal* getListFormatInternal(const Locale& locale, const char *style, UErrorCode& errorCode);
    struct U_HIDDEN ListPatternsSink;
    static ListFormatInternal* loadListFormatInternal(const Locale& locale, const char* style, UErrorCode& errorCode);

    ListFormatter() = delete;

    ListFormatInternal* owned;
    const ListFormatInternal* data;
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __LISTFORMATTER_H__
