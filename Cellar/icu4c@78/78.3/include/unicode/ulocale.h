// © 2023 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef ULOCALE_H
#define ULOCALE_H

#include "unicode/localpointer.h"
#include "unicode/uenum.h"
#include "unicode/utypes.h"

/**
 * \file
 * \brief C API: Locale ID functionality similar to C++ class Locale
 */

/**
 * Opaque C service object type for the locale API
 * @stable ICU 74
 */
struct ULocale;

/**
 * C typedef for struct ULocale.
 * @stable ICU 74
 */
typedef struct ULocale ULocale;

/**
 * Constructs an ULocale from the locale ID.
 * The created ULocale should be destroyed by calling
 * ulocale_close();
 * @param localeID the locale, a const char * pointer (need not be terminated when
 *               the length is non-negative)
 * @param length the length of the locale; if negative, then the locale need to be
 *               null terminated.
 * @param err the error code
 * @return the locale.
 *
 * @stable ICU 74
 */
U_CAPI ULocale* U_EXPORT2
ulocale_openForLocaleID(const char* localeID, int32_t length, UErrorCode* err);

/**
 * Constructs an ULocale from the provided IETF BCP 47 language tag.
 * The created ULocale should be destroyed by calling
 * ulocale_close();
 * @param tag the language tag, defined as IETF BCP 47 language tag, const
 *            char* pointer (need not be terminated when the length is non-negative)
 * @param length the length of the tag; if negative, then the tag need to be
 *               null terminated.
 * @param err the error code
 * @return the locale.
 *
 * @stable ICU 74
 */
U_CAPI ULocale* U_EXPORT2
ulocale_openForLanguageTag(const char* tag, int32_t length, UErrorCode* err);

/**
 * Close the locale and destroy it's internal states.
 *
 * @param locale the locale
 * @stable ICU 74
 */
U_CAPI void U_EXPORT2
ulocale_close(ULocale* locale);

/**
 * Returns the locale's ISO-639 language code.
 *
 * @param locale the locale
 * @return      the language code of the locale.
 * @stable ICU 74
 */
U_CAPI const char* U_EXPORT2
ulocale_getLanguage(const ULocale* locale);

/**
 * Returns the locale's ISO-15924 abbreviation script code.
 *
 * @param locale the locale
 * @return      A pointer to the script.
 * @stable ICU 74
 */
U_CAPI const char* U_EXPORT2
ulocale_getScript(const ULocale* locale);

/**
 * Returns the locale's ISO-3166 region code.
 *
 * @param locale the locale
 * @return      A pointer to the region.
 * @stable ICU 74
 */
U_CAPI const char* U_EXPORT2
ulocale_getRegion(const ULocale* locale);

/**
 * Returns the locale's variant code.
 *
 * @param locale the locale
 * @return      A pointer to the variant.
 * @stable ICU 74
 */
U_CAPI const char* U_EXPORT2
ulocale_getVariant(const ULocale* locale);

/**
 * Returns the programmatic name of the entire locale, with the language,
 * country and variant separated by underbars. If a field is missing, up
 * to two leading underbars will occur. Example: "en", "de_DE", "en_US_WIN",
 * "de__POSIX", "fr__MAC", "__MAC", "_MT", "_FR_EURO"
 *
 * @param locale the locale
 * @return      A pointer to "name".
 * @stable ICU 74
 */
U_CAPI const char* U_EXPORT2
ulocale_getLocaleID(const ULocale* locale);

/**
 * Returns the programmatic name of the entire locale as ulocale_getLocaleID()
 * would return, but without keywords.
 *
 * @param locale the locale
 * @return      A pointer to "base name".
 * @stable ICU 74
 */
U_CAPI const char* U_EXPORT2
ulocale_getBaseName(const ULocale* locale);

/**
 * Gets the bogus state. Locale object can be bogus if it doesn't exist
 *
 * @param locale the locale
 * @return false if it is a real locale, true if it is a bogus locale
 * @stable ICU 74
 */
U_CAPI bool U_EXPORT2
ulocale_isBogus(const ULocale* locale);

/**
 * Gets the list of keywords for the specified locale.
 *
 * @param locale the locale
 * @param err the error code
 * @return pointer to UEnumeration, or nullptr if there are no keywords.
 * Client must call uenum_close() to dispose the returned value.
 * @stable ICU 74
 */
U_CAPI UEnumeration* U_EXPORT2
ulocale_getKeywords(const ULocale* locale, UErrorCode *err);

/**
 * Gets the list of unicode keywords for the specified locale.
 *
 * @param locale the locale
 * @param err the error code
 * @return pointer to UEnumeration, or nullptr if there are no keywords.
 * Client must call uenum_close() to dispose the returned value.
 * @stable ICU 74
 */
U_CAPI UEnumeration* U_EXPORT2
ulocale_getUnicodeKeywords(const ULocale* locale, UErrorCode *err);

/**
 * Gets the value for a keyword.
 *
 * This uses legacy keyword=value pairs, like "collation=phonebook".
 *
 * @param locale the locale
 * @param keyword the keyword, a const char * pointer (need not be
 *                terminated when the length is non-negative)
 * @param keywordLength the length of the keyword; if negative, then the
 *                      keyword need to be null terminated.
 * @param valueBuffer The buffer to receive the value.
 * @param valueBufferCapacity The capacity of receiving valueBuffer.
 * @param err the error code
 * @stable ICU 74
 */
U_CAPI int32_t U_EXPORT2
ulocale_getKeywordValue(
    const ULocale* locale, const char* keyword, int32_t keywordLength,
    char* valueBuffer, int32_t valueBufferCapacity, UErrorCode *err);

/**
 * Gets the Unicode value for a Unicode keyword.
 *
 * This uses Unicode key-value pairs, like "co-phonebk".
 *
 * @param locale the locale
 * @param keyword the Unicode keyword, a const char * pointer (need not be
 *                terminated when the length is non-negative)
 * @param keywordLength the length of the Unicode keyword; if negative,
 *                      then the keyword need to be null terminated.
 * @param valueBuffer The buffer to receive the Unicode value.
 * @param valueBufferCapacity The capacity of receiving valueBuffer.
 * @param err the error code
 * @stable ICU 74
 */
U_CAPI int32_t U_EXPORT2
ulocale_getUnicodeKeywordValue(
    const ULocale* locale, const char* keyword, int32_t keywordLength,
    char* valueBuffer, int32_t valueBufferCapacity, UErrorCode *err);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalULocalePointer
 * "Smart pointer" class, closes a ULocale via ulocale_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 74
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalULocalePointer, ULocale, ulocale_close);

U_NAMESPACE_END

#endif  /* U_SHOW_CPLUSPLUS_API */

#endif /*_ULOCALE */
