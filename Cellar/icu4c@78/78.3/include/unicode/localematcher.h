// © 2019 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

// localematcher.h
// created: 2019may08 Markus W. Scherer

#ifndef __LOCALEMATCHER_H__
#define __LOCALEMATCHER_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include <optional>

#include "unicode/locid.h"
#include "unicode/stringpiece.h"
#include "unicode/uobject.h"

/**
 * \file
 * \brief C++ API: Locale matcher: User's desired locales vs. application's supported locales.
 */

/**
 * Builder option for whether the language subtag or the script subtag is most important.
 *
 * @see LocaleMatcher::Builder#setFavorSubtag(ULocMatchFavorSubtag)
 * @stable ICU 65
 */
enum ULocMatchFavorSubtag {
    /**
     * Language differences are most important, then script differences, then region differences.
     * (This is the default behavior.)
     *
     * @stable ICU 65
     */
    ULOCMATCH_FAVOR_LANGUAGE,
    /**
     * Makes script differences matter relatively more than language differences.
     *
     * @stable ICU 65
     */
    ULOCMATCH_FAVOR_SCRIPT
};
#ifndef U_IN_DOXYGEN
typedef enum ULocMatchFavorSubtag ULocMatchFavorSubtag;
#endif

/**
 * Builder option for whether all desired locales are treated equally or
 * earlier ones are preferred.
 *
 * @see LocaleMatcher::Builder#setDemotionPerDesiredLocale(ULocMatchDemotion)
 * @stable ICU 65
 */
enum ULocMatchDemotion {
    /**
     * All desired locales are treated equally.
     *
     * @stable ICU 65
     */
    ULOCMATCH_DEMOTION_NONE,
    /**
     * Earlier desired locales are preferred.
     *
     * <p>From each desired locale to the next,
     * the distance to any supported locale is increased by an additional amount
     * which is at least as large as most region mismatches.
     * A later desired locale has to have a better match with some supported locale
     * due to more than merely having the same region subtag.
     *
     * <p>For example: <code>Supported={en, sv}  desired=[en-GB, sv]</code>
     * yields <code>Result(en-GB, en)</code> because
     * with the demotion of sv its perfect match is no better than
     * the region distance between the earlier desired locale en-GB and en=en-US.
     *
     * <p>Notes:
     * <ul>
     *   <li>In some cases, language and/or script differences can be as small as
     *       the typical region difference. (Example: sr-Latn vs. sr-Cyrl)
     *   <li>It is possible for certain region differences to be larger than usual,
     *       and larger than the demotion.
     *       (As of CLDR 35 there is no such case, but
     *        this is possible in future versions of the data.)
     * </ul>
     *
     * @stable ICU 65
     */
    ULOCMATCH_DEMOTION_REGION
};
#ifndef U_IN_DOXYGEN
typedef enum ULocMatchDemotion ULocMatchDemotion;
#endif

/**
 * Builder option for whether to include or ignore one-way (fallback) match data.
 * The LocaleMatcher uses CLDR languageMatch data which includes fallback (oneway=true) entries.
 * Sometimes it is desirable to ignore those.
 *
 * <p>For example, consider a web application with the UI in a given language,
 * with a link to another, related web app.
 * The link should include the UI language, and the target server may also use
 * the client’s Accept-Language header data.
 * The target server has its own list of supported languages.
 * One may want to favor UI language consistency, that is,
 * if there is a decent match for the original UI language, we want to use it,
 * but not if it is merely a fallback.
 *
 * @see LocaleMatcher::Builder#setDirection(ULocMatchDirection)
 * @stable ICU 67
 */
enum ULocMatchDirection {
    /**
     * Locale matching includes one-way matches such as Breton→French. (default)
     *
     * @stable ICU 67
     */
    ULOCMATCH_DIRECTION_WITH_ONE_WAY,
    /**
     * Locale matching limited to two-way matches including e.g. Danish↔Norwegian
     * but ignoring one-way matches.
     *
     * @stable ICU 67
     */
    ULOCMATCH_DIRECTION_ONLY_TWO_WAY
};
#ifndef U_IN_DOXYGEN
typedef enum ULocMatchDirection ULocMatchDirection;
#endif

struct UHashtable;

U_NAMESPACE_BEGIN

struct LSR;

class LikelySubtags;
class LocaleDistance;
class LocaleLsrIterator;
class UVector;

/**
 * Immutable class that picks the best match between a user's desired locales and
 * an application's supported locales.
 * Movable but not copyable.
 *
 * <p>Example:
 * <pre>
 * UErrorCode errorCode = U_ZERO_ERROR;
 * LocaleMatcher matcher = LocaleMatcher::Builder().setSupportedLocales("fr, en-GB, en").build(errorCode);
 * Locale *bestSupported = matcher.getBestLocale(Locale.US, errorCode);  // "en"
 * </pre>
 *
 * <p>A matcher takes into account when languages are close to one another,
 * such as Danish and Norwegian,
 * and when regional variants are close, like en-GB and en-AU as opposed to en-US.
 *
 * <p>If there are multiple supported locales with the same (language, script, region)
 * likely subtags, then the current implementation returns the first of those locales.
 * It ignores variant subtags (except for pseudolocale variants) and extensions.
 * This may change in future versions.
 *
 * <p>For example, the current implementation does not distinguish between
 * de, de-DE, de-Latn, de-1901, de-u-co-phonebk.
 *
 * <p>If you prefer one equivalent locale over another, then provide only the preferred one,
 * or place it earlier in the list of supported locales.
 *
 * <p>Otherwise, the order of supported locales may have no effect on the best-match results.
 * The current implementation compares each desired locale with supported locales
 * in the following order:
 * 1. Default locale, if supported;
 * 2. CLDR "paradigm locales" like en-GB and es-419;
 * 3. other supported locales.
 * This may change in future versions.
 *
 * <p>Often a product will just need one matcher instance, built with the languages
 * that it supports. However, it may want multiple instances with different
 * default languages based on additional information, such as the domain.
 *
 * <p>This class is not intended for public subclassing.
 *
 * @stable ICU 65
 */
class U_COMMON_API LocaleMatcher : public UMemory {
public:
    /**
     * Data for the best-matching pair of a desired and a supported locale.
     * Movable but not copyable.
     *
     * @stable ICU 65
     */
    class U_COMMON_API Result : public UMemory {
    public:
        /**
         * Move constructor; might modify the source.
         * This object will have the same contents that the source object had.
         *
         * @param src Result to move contents from.
         * @stable ICU 65
         */
        Result(Result &&src) noexcept;

        /**
         * Destructor.
         *
         * @stable ICU 65
         */
        ~Result();

        /**
         * Move assignment; might modify the source.
         * This object will have the same contents that the source object had.
         *
         * @param src Result to move contents from.
         * @stable ICU 65
         */
        Result &operator=(Result &&src) noexcept;

        /**
         * Returns the best-matching desired locale.
         * nullptr if the list of desired locales is empty or if none matched well enough.
         *
         * @return the best-matching desired locale, or nullptr.
         * @stable ICU 65
         */
        inline const Locale *getDesiredLocale() const { return desiredLocale; }

        /**
         * Returns the best-matching supported locale.
         * If none matched well enough, this is the default locale.
         * The default locale is nullptr if Builder::setNoDefaultLocale() was called,
         * or if the list of supported locales is empty and no explicit default locale is set.
         *
         * @return the best-matching supported locale, or nullptr.
         * @stable ICU 65
         */
        inline const Locale *getSupportedLocale() const { return supportedLocale; }

        /**
         * Returns the index of the best-matching desired locale in the input Iterable order.
         * -1 if the list of desired locales is empty or if none matched well enough.
         *
         * @return the index of the best-matching desired locale, or -1.
         * @stable ICU 65
         */
        inline int32_t getDesiredIndex() const { return desiredIndex; }

        /**
         * Returns the index of the best-matching supported locale in the
         * constructor’s or builder’s input order (“set” Collection plus “added” locales).
         * If the matcher was built from a locale list string, then the iteration order is that
         * of a LocalePriorityList built from the same string.
         * -1 if the list of supported locales is empty or if none matched well enough.
         *
         * @return the index of the best-matching supported locale, or -1.
         * @stable ICU 65
         */
        inline int32_t getSupportedIndex() const { return supportedIndex; }

        /**
         * Takes the best-matching supported locale and adds relevant fields of the
         * best-matching desired locale, such as the -t- and -u- extensions.
         * May replace some fields of the supported locale.
         * The result is the locale that should be used for date and number formatting, collation, etc.
         * Returns the root locale if getSupportedLocale() returns nullptr.
         *
         * <p>Example: desired=ar-SA-u-nu-latn, supported=ar-EG, resolved locale=ar-SA-u-nu-latn
         *
         * @return a locale combining the best-matching desired and supported locales.
         * @stable ICU 65
         */
        Locale makeResolvedLocale(UErrorCode &errorCode) const;

    private:
        Result(const Locale *desired, const Locale *supported,
               int32_t desIndex, int32_t suppIndex, UBool owned) :
                desiredLocale(desired), supportedLocale(supported),
                desiredIndex(desIndex), supportedIndex(suppIndex),
                desiredIsOwned(owned) {}

        Result(const Result &other) = delete;
        Result &operator=(const Result &other) = delete;

        const Locale *desiredLocale;
        const Locale *supportedLocale;
        int32_t desiredIndex;
        int32_t supportedIndex;
        UBool desiredIsOwned;

        friend class LocaleMatcher;
    };

    /**
     * LocaleMatcher builder.
     * Movable but not copyable.
     *
     * @stable ICU 65
     */
    class U_COMMON_API Builder : public UMemory {
    public:
        /**
         * Constructs a builder used in chaining parameters for building a LocaleMatcher.
         *
         * @return a new Builder object
         * @stable ICU 65
         */
        Builder() {}

        /**
         * Move constructor; might modify the source.
         * This builder will have the same contents that the source builder had.
         *
         * @param src Builder to move contents from.
         * @stable ICU 65
         */
        Builder(Builder &&src) noexcept;

        /**
         * Destructor.
         *
         * @stable ICU 65
         */
        ~Builder();

        /**
         * Move assignment; might modify the source.
         * This builder will have the same contents that the source builder had.
         *
         * @param src Builder to move contents from.
         * @stable ICU 65
         */
        Builder &operator=(Builder &&src) noexcept;

        /**
         * Parses an Accept-Language string
         * (<a href="https://tools.ietf.org/html/rfc2616#section-14.4">RFC 2616 Section 14.4</a>),
         * such as "af, en, fr;q=0.9", and sets the supported locales accordingly.
         * Allows whitespace in more places but does not allow "*".
         * Clears any previously set/added supported locales first.
         *
         * @param locales the Accept-Language string of locales to set
         * @return this Builder object
         * @stable ICU 65
         */
        Builder &setSupportedLocalesFromListString(StringPiece locales);

        /**
         * Copies the supported locales, preserving iteration order.
         * Clears any previously set/added supported locales first.
         * Duplicates are allowed, and are not removed.
         *
         * @param locales the list of locale
         * @return this Builder object
         * @stable ICU 65
         */
        Builder &setSupportedLocales(Locale::Iterator &locales);

        /**
         * Copies the supported locales from the begin/end range, preserving iteration order.
         * Clears any previously set/added supported locales first.
         * Duplicates are allowed, and are not removed.
         *
         * Each of the iterator parameter values must be an
         * input iterator whose value is convertible to const Locale &.
         *
         * @param begin Start of range.
         * @param end Exclusive end of range.
         * @return this Builder object
         * @stable ICU 65
         */
        template<typename Iter>
        Builder &setSupportedLocales(Iter begin, Iter end) {
            if (U_FAILURE(errorCode_)) { return *this; }
            clearSupportedLocales();
            while (begin != end) {
                addSupportedLocale(*begin++);
            }
            return *this;
        }

        /**
         * Copies the supported locales from the begin/end range, preserving iteration order.
         * Calls the converter to convert each *begin to a Locale or const Locale &.
         * Clears any previously set/added supported locales first.
         * Duplicates are allowed, and are not removed.
         *
         * Each of the iterator parameter values must be an
         * input iterator whose value is convertible to const Locale &.
         *
         * @param begin Start of range.
         * @param end Exclusive end of range.
         * @param converter Converter from *begin to const Locale & or compatible.
         * @return this Builder object
         * @stable ICU 65
         */
        template<typename Iter, typename Conv>
        Builder &setSupportedLocalesViaConverter(Iter begin, Iter end, Conv converter) {
            if (U_FAILURE(errorCode_)) { return *this; }
            clearSupportedLocales();
            while (begin != end) {
                addSupportedLocale(converter(*begin++));
            }
            return *this;
        }

        /**
         * Adds another supported locale.
         * Duplicates are allowed, and are not removed.
         *
         * @param locale another locale
         * @return this Builder object
         * @stable ICU 65
         */
        Builder &addSupportedLocale(const Locale &locale);

        /**
         * Sets no default locale.
         * There will be no explicit or implicit default locale.
         * If there is no good match, then the matcher will return nullptr for the
         * best supported locale.
         *
         * @stable ICU 68
         */
        Builder &setNoDefaultLocale();

        /**
         * Sets the default locale; if nullptr, or if it is not set explicitly,
         * then the first supported locale is used as the default locale.
         * There is no default locale at all (nullptr will be returned instead)
         * if setNoDefaultLocale() is called.
         *
         * @param defaultLocale the default locale (will be copied)
         * @return this Builder object
         * @stable ICU 65
         */
        Builder &setDefaultLocale(const Locale *defaultLocale);

        /**
         * If ULOCMATCH_FAVOR_SCRIPT, then the language differences are smaller than script
         * differences.
         * This is used in situations (such as maps) where
         * it is better to fall back to the same script than a similar language.
         *
         * @param subtag the subtag to favor
         * @return this Builder object
         * @stable ICU 65
         */
        Builder &setFavorSubtag(ULocMatchFavorSubtag subtag);

        /**
         * Option for whether all desired locales are treated equally or
         * earlier ones are preferred (this is the default).
         *
         * @param demotion the demotion per desired locale to set.
         * @return this Builder object
         * @stable ICU 65
         */
        Builder &setDemotionPerDesiredLocale(ULocMatchDemotion demotion);

        /**
         * Option for whether to include or ignore one-way (fallback) match data.
         * By default, they are included.
         *
         * @param matchDirection the match direction to set.
         * @return this Builder object
         * @stable ICU 67
         */
        Builder &setDirection(ULocMatchDirection matchDirection) {
            if (U_SUCCESS(errorCode_)) {
                direction_ = matchDirection;
            }
            return *this;
        }

        /**
         * Sets the maximum distance for an acceptable match.
         * The matcher will return a match for a pair of locales only if
         * they match at least as well as the pair given here.
         *
         * For example, setMaxDistance(en-US, en-GB) limits matches to ones where the
         * (desired, support) locales have a distance no greater than a region subtag difference.
         * This is much stricter than the CLDR default.
         *
         * The details of locale matching are subject to changes in
         * CLDR data and in the algorithm.
         * Specifying a maximum distance in relative terms via a sample pair of locales
         * insulates from changes that affect all distance metrics similarly,
         * but some changes will necessarily affect relative distances between
         * different pairs of locales.
         *
         * @param desired the desired locale for distance comparison.
         * @param supported the supported locale for distance comparison.
         * @return this Builder object
         * @stable ICU 68
         */
        Builder &setMaxDistance(const Locale &desired, const Locale &supported);

        /**
         * Sets the UErrorCode if an error occurred while setting parameters.
         * Preserves older error codes in the outErrorCode.
         *
         * @param outErrorCode Set to an error code if it does not contain one already
         *                  and an error occurred while setting parameters.
         *                  Otherwise unchanged.
         * @return true if U_FAILURE(outErrorCode)
         * @stable ICU 65
         */
        UBool copyErrorTo(UErrorCode &outErrorCode) const;

        /**
         * Builds and returns a new locale matcher.
         * This builder can continue to be used.
         *
         * @param errorCode ICU error code. Its input value must pass the U_SUCCESS() test,
         *                  or else the function returns immediately. Check for U_FAILURE()
         *                  on output or use with function chaining. (See User Guide for details.)
         * @return LocaleMatcher
         * @stable ICU 65
         */
        LocaleMatcher build(UErrorCode &errorCode) const;

    private:
        friend class LocaleMatcher;

        Builder(const Builder &other) = delete;
        Builder &operator=(const Builder &other) = delete;

        void clearSupportedLocales();
        bool ensureSupportedLocaleVector();

        UErrorCode errorCode_ = U_ZERO_ERROR;
        UVector *supportedLocales_ = nullptr;
        int32_t thresholdDistance_ = -1;
        ULocMatchDemotion demotion_ = ULOCMATCH_DEMOTION_REGION;
        Locale *defaultLocale_ = nullptr;
        bool withDefault_ = true;
        ULocMatchFavorSubtag favor_ = ULOCMATCH_FAVOR_LANGUAGE;
        ULocMatchDirection direction_ = ULOCMATCH_DIRECTION_WITH_ONE_WAY;
        Locale *maxDistanceDesired_ = nullptr;
        Locale *maxDistanceSupported_ = nullptr;
    };

    // FYI No public LocaleMatcher constructors in C++; use the Builder.

    /**
     * Move copy constructor; might modify the source.
     * This matcher will have the same settings that the source matcher had.
     * @param src source matcher
     * @stable ICU 65
     */
    LocaleMatcher(LocaleMatcher &&src) noexcept;

    /**
     * Destructor.
     * @stable ICU 65
     */
    ~LocaleMatcher();

    /**
     * Move assignment operator; might modify the source.
     * This matcher will have the same settings that the source matcher had.
     * The behavior is undefined if *this and src are the same object.
     * @param src source matcher
     * @return *this
     * @stable ICU 65
     */
    LocaleMatcher &operator=(LocaleMatcher &&src) noexcept;

    /**
     * Returns the supported locale which best matches the desired locale.
     *
     * @param desiredLocale Typically a user's language.
     * @param errorCode ICU error code. Its input value must pass the U_SUCCESS() test,
     *                  or else the function returns immediately. Check for U_FAILURE()
     *                  on output or use with function chaining. (See User Guide for details.)
     * @return the best-matching supported locale.
     * @stable ICU 65
     */
    const Locale *getBestMatch(const Locale &desiredLocale, UErrorCode &errorCode) const;

    /**
     * Returns the supported locale which best matches one of the desired locales.
     *
     * @param desiredLocales Typically a user's languages, in order of preference (descending).
     * @param errorCode ICU error code. Its input value must pass the U_SUCCESS() test,
     *                  or else the function returns immediately. Check for U_FAILURE()
     *                  on output or use with function chaining. (See User Guide for details.)
     * @return the best-matching supported locale.
     * @stable ICU 65
     */
    const Locale *getBestMatch(Locale::Iterator &desiredLocales, UErrorCode &errorCode) const;

    /**
     * Parses an Accept-Language string
     * (<a href="https://tools.ietf.org/html/rfc2616#section-14.4">RFC 2616 Section 14.4</a>),
     * such as "af, en, fr;q=0.9",
     * and returns the supported locale which best matches one of the desired locales.
     * Allows whitespace in more places but does not allow "*".
     *
     * @param desiredLocaleList Typically a user's languages, as an Accept-Language string.
     * @param errorCode ICU error code. Its input value must pass the U_SUCCESS() test,
     *                  or else the function returns immediately. Check for U_FAILURE()
     *                  on output or use with function chaining. (See User Guide for details.)
     * @return the best-matching supported locale.
     * @stable ICU 65
     */
    const Locale *getBestMatchForListString(StringPiece desiredLocaleList, UErrorCode &errorCode) const;

    /**
     * Returns the best match between the desired locale and the supported locales.
     * If the result's desired locale is not nullptr, then it is the address of the input locale.
     * It has not been cloned.
     *
     * @param desiredLocale Typically a user's language.
     * @param errorCode ICU error code. Its input value must pass the U_SUCCESS() test,
     *                  or else the function returns immediately. Check for U_FAILURE()
     *                  on output or use with function chaining. (See User Guide for details.)
     * @return the best-matching pair of the desired and a supported locale.
     * @stable ICU 65
     */
    Result getBestMatchResult(const Locale &desiredLocale, UErrorCode &errorCode) const;

    /**
     * Returns the best match between the desired and supported locales.
     * If the result's desired locale is not nullptr, then it is a clone of
     * the best-matching desired locale. The Result object owns the clone.
     *
     * @param desiredLocales Typically a user's languages, in order of preference (descending).
     * @param errorCode ICU error code. Its input value must pass the U_SUCCESS() test,
     *                  or else the function returns immediately. Check for U_FAILURE()
     *                  on output or use with function chaining. (See User Guide for details.)
     * @return the best-matching pair of a desired and a supported locale.
     * @stable ICU 65
     */
    Result getBestMatchResult(Locale::Iterator &desiredLocales, UErrorCode &errorCode) const;

    /**
     * Returns true if the pair of locales matches acceptably.
     * This is influenced by Builder options such as setDirection(), setFavorSubtag(),
     * and setMaxDistance().
     *
     * @param desired The desired locale.
     * @param supported The supported locale.
     * @param errorCode ICU error code. Its input value must pass the U_SUCCESS() test,
     *                  or else the function returns immediately. Check for U_FAILURE()
     *                  on output or use with function chaining. (See User Guide for details.)
     * @return true if the pair of locales matches acceptably.
     * @stable ICU 68
     */
    UBool isMatch(const Locale &desired, const Locale &supported, UErrorCode &errorCode) const;

#ifndef U_HIDE_INTERNAL_API
    /**
     * Returns a fraction between 0 and 1, where 1 means that the languages are a
     * perfect match, and 0 means that they are completely different.
     *
     * <p>This is mostly an implementation detail, and the precise values may change over time.
     * The implementation may use either the maximized forms or the others ones, or both.
     * The implementation may or may not rely on the forms to be consistent with each other.
     *
     * <p>Callers should construct and use a matcher rather than match pairs of locales directly.
     *
     * @param desired Desired locale.
     * @param supported Supported locale.
     * @param errorCode ICU error code. Its input value must pass the U_SUCCESS() test,
     *                  or else the function returns immediately. Check for U_FAILURE()
     *                  on output or use with function chaining. (See User Guide for details.)
     * @return value between 0 and 1, inclusive.
     * @internal (has a known user)
     */
    double internalMatch(const Locale &desired, const Locale &supported, UErrorCode &errorCode) const;
#endif  // U_HIDE_INTERNAL_API

private:
    LocaleMatcher(const Builder &builder, UErrorCode &errorCode);
    LocaleMatcher(const LocaleMatcher &other) = delete;
    LocaleMatcher &operator=(const LocaleMatcher &other) = delete;

    int32_t putIfAbsent(const LSR &lsr, int32_t i, int32_t suppLength, UErrorCode &errorCode);

    std::optional<int32_t> getBestSuppIndex(LSR desiredLSR, LocaleLsrIterator *remainingIter, UErrorCode &errorCode) const;

    const LikelySubtags &likelySubtags;
    const LocaleDistance &localeDistance;
    int32_t thresholdDistance;
    int32_t demotionPerDesiredLocale;
    ULocMatchFavorSubtag favorSubtag;
    ULocMatchDirection direction;

    // These are in input order.
    const Locale ** supportedLocales;
    LSR *lsrs;
    int32_t supportedLocalesLength;
    // These are in preference order: 1. Default locale 2. paradigm locales 3. others.
    UHashtable *supportedLsrToIndex;  // Map<LSR, Integer>
    // Array versions of the supportedLsrToIndex keys and values.
    // The distance lookup loops over the supportedLSRs and returns the index of the best match.
    const LSR **supportedLSRs;
    int32_t *supportedIndexes;
    int32_t supportedLSRsLength;
    Locale *ownedDefaultLocale;
    const Locale *defaultLocale;
};

U_NAMESPACE_END

#endif  // U_SHOW_CPLUSPLUS_API
#endif  // __LOCALEMATCHER_H__
