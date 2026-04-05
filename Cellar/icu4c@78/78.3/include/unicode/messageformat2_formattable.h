// © 2024 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#include "unicode/utypes.h"

#ifndef MESSAGEFORMAT2_FORMATTABLE_H
#define MESSAGEFORMAT2_FORMATTABLE_H

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_NORMALIZATION

#if !UCONFIG_NO_FORMATTING

#if !UCONFIG_NO_MF2

#include "unicode/chariter.h"
#include "unicode/numberformatter.h"
#include "unicode/messageformat2_data_model_names.h"
#include "unicode/smpdtfmt.h"

#ifndef U_HIDE_DEPRECATED_API

#include <map>
#include <variant>

U_NAMESPACE_BEGIN

class Hashtable;
class UVector;

namespace message2 {

    class Formatter;
    class MessageContext;
    class Selector;

    // Formattable
    // ----------

    /**
     * `FormattableObject` is an abstract class that can be implemented in order to define
     * an arbitrary class that can be passed to a custom formatter or selector function.
     * To be passed in such a way, it must be wrapped in a `Formattable` object.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API FormattableObject : public UObject {
    public:
        /**
         * Returns an arbitrary string representing the type of this object.
         * It's up to the implementor of this class, as well as the implementors
         * of any custom functions that rely on particular values of this tag
         * corresponding to particular classes that the object contents can be
         * downcast to, to ensure that the type tags are used soundly.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual const UnicodeString& tag() const = 0;
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual ~FormattableObject();
    }; // class FormattableObject

    /**
     * The `DateInfo` struct represents all the information needed to
     * format a date with a time zone. It includes an absolute date and a time zone name,
     * as well as a calendar name. The calendar name is not currently used.
     *
     * @internal ICU 78 technology preview
     * @deprecated This API is for technology preview only.
     */
    struct U_I18N_API DateInfo {
        /**
         * Date in UTC
         *
         * @internal ICU 78 technology preview
         * @deprecated This API is for technology preview only.
         */
        UDate date;
        /**
         * IANA time zone name; "UTC" if UTC; empty string if value is floating
         * The time zone is required in order to format the date/time value
         * (its offset is added to/subtracted from the datestamp in order to
         * produce the formatted date).
         *
         * @internal ICU 78 technology preview
         * @deprecated This API is for technology preview only.
         */
        UnicodeString zoneId;
    };

    /**
     * The `Formattable` class represents a typed value that can be formatted,
     * originating either from a message argument or a literal in the code.
     * ICU's Formattable class is not used in MessageFormat 2 because it's unsafe to copy an
     * icu::Formattable value that contains an object. (See ICU-20275).
     *
     * `Formattable` is immutable (not deeply immutable) and
     * is movable and copyable.
     * (Copying does not do a deep copy when the wrapped value is an array or
     * object. Likewise, while a pointer to a wrapped array or object is `const`,
     * the referents of the pointers may be mutated by other code.)
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API_CLASS Formattable : public UObject {
    public:

        /**
         * Gets the data type of this Formattable object.
         * @return    the data type of this Formattable object.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API UFormattableType getType() const;

        /**
         * Gets the double value of this object. If this object is not of type
         * UFMT_DOUBLE, then the result is undefined and the error code is set.
         *
         * @param status Input/output error code.
         * @return    the double value of this object.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API double getDouble(UErrorCode& status) const {
            if (U_SUCCESS(status)) {
                if (isDecimal() && getType() == UFMT_DOUBLE) {
                    return (std::get_if<icu::Formattable>(&contents))->getDouble();
                }
                if (std::holds_alternative<double>(contents)) {
                    return *(std::get_if<double>(&contents));
                }
                status = U_ILLEGAL_ARGUMENT_ERROR;
            }
            return 0;
        }

        /**
         * Gets the long value of this object. If this object is not of type
         * UFMT_LONG then the result is undefined and the error code is set.
         *
         * @param status Input/output error code.
         * @return    the long value of this object.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API int32_t getLong(UErrorCode& status) const {
            if (U_SUCCESS(status)) {
                if (isDecimal() && getType() == UFMT_LONG) {
                    return std::get_if<icu::Formattable>(&contents)->getLong();
                }
                if (std::holds_alternative<int64_t>(contents)) {
                    return static_cast<int32_t>(*(std::get_if<int64_t>(&contents)));
                }
                status = U_ILLEGAL_ARGUMENT_ERROR;
            }
            return 0;
        }

        /**
         * Gets the int64 value of this object. If this object is not of type
         * kInt64 then the result is undefined and the error code is set.
         * If conversion to int64 is desired, call getInt64()
         *
         * @param status Input/output error code.
         * @return    the int64 value of this object.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API int64_t getInt64Value(UErrorCode& status) const {
            if (U_SUCCESS(status)) {
                if (isDecimal() && getType() == UFMT_INT64) {
                    return std::get_if<icu::Formattable>(&contents)->getInt64();
                }
                if (std::holds_alternative<int64_t>(contents)) {
                    return *(std::get_if<int64_t>(&contents));
                }
                status = U_ILLEGAL_ARGUMENT_ERROR;
            }
            return 0;
        }

        /**
         * Gets the int64 value of this object. If this object is of a numeric
         * type and the magnitude is too large to fit in an int64, then
         * the maximum or minimum int64 value, as appropriate, is returned
         * and the status is set to U_INVALID_FORMAT_ERROR.  If the
         * magnitude fits in an int64, then a casting conversion is
         * performed, with truncation of any fractional part. If this object is
         * not a numeric type, then 0 is returned and
         * the status is set to U_INVALID_FORMAT_ERROR.
         * @param status the error code
         * @return    the int64 value of this object.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API int64_t getInt64(UErrorCode& status) const;
        /**
         * Gets the string value of this object. If this object is not of type
         * kString then the result is undefined and the error code is set.
         *
         * @param status Input/output error code.
         * @return          A reference to the string value of this object.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const UnicodeString& getString(UErrorCode& status) const {
            if (U_SUCCESS(status)) {
                if (std::holds_alternative<UnicodeString>(contents)) {
                    return *std::get_if<UnicodeString>(&contents);
                }
                status = U_ILLEGAL_ARGUMENT_ERROR;
            }
            return bogusString;
        }

        /**
         * Gets the struct representing the date value of this object.
         * If this object is not of type kDate then the result is
         * undefined and the error code is set.
         *
         * @param status Input/output error code.
         * @return   A non-owned pointer to a DateInfo object
         *           representing the underlying date of this object.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const DateInfo* getDate(UErrorCode& status) const {
            if (U_SUCCESS(status)) {
                if (isDate()) {
                    return std::get_if<DateInfo>(&contents);
                }
                status = U_ILLEGAL_ARGUMENT_ERROR;
            }
            return nullptr;
        }

        /**
         * Returns true if the data type of this Formattable object
         * is kDouble
         * @return true if this is a pure numeric object
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API UBool isNumeric() const { return (getType() == UFMT_DOUBLE || getType() == UFMT_LONG || getType() == UFMT_INT64); }

        /**
         * Gets the array value and count of this object. If this object
         * is not of type kArray then the result is undefined and the error code is set.
         *
         * @param count    fill-in with the count of this object.
         * @param status Input/output error code.
         * @return         the array value of this object.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const Formattable* getArray(int32_t& count, UErrorCode& status) const;

        /**
         * Returns a pointer to the FormattableObject contained within this
         * formattable, or if this object does not contain a FormattableObject,
         * returns nullptr and sets the error code.
         *
         * @param status Input/output error code.
         * @return a FormattableObject pointer, or nullptr
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const FormattableObject* getObject(UErrorCode& status) const {
            if (U_SUCCESS(status)) {
                // Can't return a reference since FormattableObject
                // is an abstract class
                if (getType() == UFMT_OBJECT) {
                    return *std::get_if<const FormattableObject*>(&contents);
                    // TODO: should assert that if type is object, object is non-null
                }
                status = U_ILLEGAL_ARGUMENT_ERROR;
            }
            return nullptr;
        }
        /**
         * Non-member swap function.
         * @param f1 will get f2's contents
         * @param f2 will get f1's contents
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API friend inline void swap(Formattable& f1, Formattable& f2) noexcept {
            using std::swap;

            swap(f1.contents, f2.contents);
        }
        /**
         * Copy constructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable(const Formattable&);
        /**
         * Assignment operator
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable& operator=(Formattable) noexcept;
        /**
         * Default constructor. Leaves the Formattable in a
         * valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable() : contents(0.0) {}
        /**
         * String constructor.
         *
         * @param s A string to wrap as a Formattable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable(const UnicodeString& s) : contents(s) {}
        /**
         * Double constructor.
         *
         * @param d A double value to wrap as a Formattable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable(double d) : contents(d) {}
        /**
         * Int64 constructor.
         *
         * @param i An int64 value to wrap as a Formattable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable(int64_t i) : contents(i) {}
        /**
         * Date constructor.
         *
         * @param d A DateInfo struct representing a date,
         *          to wrap as a Formattable.
         *          Passed by move
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable(DateInfo&& d) : contents(std::move(d)) {}
        /**
         * Creates a Formattable object of an appropriate numeric type from a
         * a decimal number in string form.  The Formattable will retain the
         * full precision of the input in decimal format, even when it exceeds
         * what can be represented by a double or int64_t.
         *
         * @param number  the unformatted (not localized) string representation
         *                     of the Decimal number.
         * @param status  the error code.  Possible errors include U_INVALID_FORMAT_ERROR
         *                if the format of the string does not conform to that of a
         *                decimal number.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API static Formattable forDecimal(std::string_view number, UErrorCode& status);
        /**
         * Array constructor.
         *
         * @param arr An array of Formattables, which is adopted.
         * @param len The length of the array.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable(const Formattable* arr, int32_t len) : contents(std::pair(arr, len)) {}
        /**
         * Object constructor.
         *
         * @param obj A FormattableObject (not adopted).
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API Formattable(const FormattableObject* obj) : contents(obj) {}
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API virtual ~Formattable();
        /**
         * Converts the Formattable object to an ICU Formattable object.
         * If this has type UFMT_OBJECT or kArray, then `status` is set to
         * U_ILLEGAL_ARGUMENT_ERROR.
         *
         * @param status Input/output error code.
         * @return An icu::Formattable value with the same value as this.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API icu::Formattable asICUFormattable(UErrorCode& status) const;
    private:

        std::variant<double,
                     int64_t,
                     UnicodeString,
                     icu::Formattable, // represents a Decimal
                     DateInfo,
                     const FormattableObject*,
                     std::pair<const Formattable*, int32_t>> contents;
        UnicodeString bogusString; // :((((

        UBool isDecimal() const {
            return std::holds_alternative<icu::Formattable>(contents);
        }
        UBool isDate() const {
            return std::holds_alternative<DateInfo>(contents);
        }
    }; // class Formattable

/**
 * Internal use only, but has to be included here as part of the implementation
 * of the header-only `FunctionOptions::getOptions()` method
 *
 *  A `ResolvedFunctionOption` represents the result of evaluating
 * a single named function option. It pairs the given name with the `Formattable`
 * value resulting from evaluating the option's value.
 *
 * `ResolvedFunctionOption` is immutable and is not copyable or movable.
 *
 * @internal ICU 75 technology preview
 * @deprecated This API is for technology preview only.
 */
#ifndef U_IN_DOXYGEN
class U_I18N_API_CLASS ResolvedFunctionOption : public UObject {
  private:

    /* const */ UnicodeString name;
    /* const */ Formattable value;
    // True iff this option was represented in the syntax by a literal value.
    // This is necessary in order to implement the spec for the `select` option
    // of `:number` and `:integer`.
    /* const */ bool sourceIsLiteral;

  public:
      U_I18N_API const UnicodeString& getName() const { return name; }
      U_I18N_API const Formattable& getValue() const { return value; }
      U_I18N_API bool isLiteral() const { return sourceIsLiteral; }
      U_I18N_API ResolvedFunctionOption(const UnicodeString& n, const Formattable& f, bool s)
          : name(n), value(f), sourceIsLiteral(s) {}
      U_I18N_API ResolvedFunctionOption() {}
      U_I18N_API ResolvedFunctionOption(ResolvedFunctionOption&&);
      U_I18N_API ResolvedFunctionOption& operator=(ResolvedFunctionOption&& other) noexcept {
          name = std::move(other.name);
          value = std::move(other.value);
          sourceIsLiteral = other.sourceIsLiteral;
          return *this;
    }
    U_I18N_API virtual ~ResolvedFunctionOption();
}; // class ResolvedFunctionOption
#endif

/**
 * Mapping from option names to `message2::Formattable` objects, obtained
 * by calling `getOptions()` on a `FunctionOptions` object.
 *
 * @internal ICU 75 technology preview
 * @deprecated This API is for technology preview only.
 */
using FunctionOptionsMap = std::map<UnicodeString, message2::Formattable>;

/**
 * Structure encapsulating named options passed to a custom selector or formatter.
 *
 * @internal ICU 75 technology preview
 * @deprecated This API is for technology preview only.
 */
class U_I18N_API FunctionOptions : public UObject {
 public:
    /**
     * Returns a map of all name-value pairs provided as options to this function.
     * The syntactic order of options is not guaranteed to
     * be preserved.
     *
     * This class is immutable and movable but not copyable.
     *
     * @return           A map from strings to `message2::Formattable` objects representing
     *                   the results of resolving each option value.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    FunctionOptionsMap getOptions() const {
        int32_t len;
        const ResolvedFunctionOption* resolvedOptions = getResolvedFunctionOptions(len);
        FunctionOptionsMap result;
        for (int32_t i = 0; i < len; i++) {
            const ResolvedFunctionOption& opt = resolvedOptions[i];
            result[opt.getName()] = opt.getValue();
        }
        return result;
    }
    /**
     * Default constructor.
     * Returns an empty mapping.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    FunctionOptions() { options = nullptr; }
    /**
     * Destructor.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    virtual ~FunctionOptions();
    /**
     * Move assignment operator:
     * The source FunctionOptions will be left in a valid but undefined state.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    FunctionOptions& operator=(FunctionOptions&&) noexcept;
    /**
     * Move constructor:
     * The source FunctionOptions will be left in a valid but undefined state.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    FunctionOptions(FunctionOptions&&);
    /**
     * Copy constructor.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    FunctionOptions& operator=(const FunctionOptions&) = delete;
 private:
    friend class InternalValue;
    friend class MessageFormatter;
    friend class StandardFunctions;

    explicit FunctionOptions(UVector&&, UErrorCode&);

    const ResolvedFunctionOption* getResolvedFunctionOptions(int32_t& len) const;
    UBool getFunctionOption(std::u16string_view, Formattable&) const;
    UBool wasSetFromLiteral(const UnicodeString&) const;
    // Returns empty string if option doesn't exist
    UnicodeString getStringFunctionOption(std::u16string_view) const;
    int32_t optionsCount() const { return functionOptionsLen; }

    // Named options passed to functions
    // This is not a Hashtable in order to make it possible for code in a public header file
    // to construct a std::map from it, on-the-fly. Otherwise, it would be impossible to put
    // that code in the header because it would have to call internal Hashtable methods.
    ResolvedFunctionOption* options;
    int32_t functionOptionsLen = 0;

    /**
     * The original FunctionOptions isn't usable after this call.
     * @returns A new, merged FunctionOptions.
     */
    FunctionOptions mergeOptions(FunctionOptions&& other, UErrorCode&);
}; // class FunctionOptions

    /**
     * A `FormattedValue` represents the result of formatting a `message2::Formattable`.
     * It contains either a string or a formatted number. (More types could be added
     * in the future.)
     *
     * `FormattedValue` is immutable and movable. It is not copyable.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API FormattedValue : public UObject {
    public:
        /**
         * Formatted string constructor.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        explicit FormattedValue(const UnicodeString&);
        /**
         * Formatted number constructor.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        explicit FormattedValue(number::FormattedNumber&&);
        /**
         * Default constructor. Leaves the FormattedValue in
         * a valid but undefined state.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        FormattedValue() : type(kString) {}
        /**
         * Returns true iff this is a formatted string.
         *
         * @return True if and only if this value is a formatted string.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        bool isString() const { return type == kString; }
        /**
         * Returns true iff this is a formatted number.
         *
         * @return True if and only if this value is a formatted number.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        bool isNumber() const { return type == kNumber; }
        /**
         * Gets the string contents of this value. If !isString(), then
         * the result is undefined.
         * @return          A reference to a formatted string.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        const UnicodeString& getString() const { return stringOutput; }
        /**
         * Gets the number contents of this value. If !isNumber(), then
         * the result is undefined.
         * @return          A reference to a formatted number.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        const number::FormattedNumber& getNumber() const { return numberOutput; }
        /**
         * Move assignment operator:
         * The source FormattedValue will be left in a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        FormattedValue& operator=(FormattedValue&&) noexcept;
        /**
         * Move constructor:
         * The source FormattedValue will be left in a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        FormattedValue(FormattedValue&& other) { *this = std::move(other); }
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        virtual ~FormattedValue();
    private:
        enum Type {
            kString,
            kNumber
        };
        Type type;
        UnicodeString stringOutput;
        number::FormattedNumber numberOutput;
    }; // class FormattedValue

    /**
     * A `FormattablePlaceholder` encapsulates an input value (a `message2::Formattable`)
     * together with an optional output value (a `message2::FormattedValue`).
     *  More information, such as source line/column numbers, could be added to the class
     * in the future.
     *
     * `FormattablePlaceholder` is immutable (not deeply immutable) and movable.
     * It is not copyable.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API_CLASS FormattedPlaceholder : public UObject {
    public:
        /**
         * Fallback constructor. Constructs a value that represents a formatting error,
         * without recording an input `Formattable` as the source.
         *
         * @param s An error string. (See the MessageFormat specification for details
         *        on fallback strings.)
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API explicit FormattedPlaceholder(const UnicodeString& s) : fallback(s), type(kFallback) {}
        /**
         * Constructor for fully formatted placeholders.
         *
         * @param input A `FormattedPlaceholder` containing the fallback string and source
         *        `Formattable` used to construct the formatted value.
         * @param output A `FormattedValue` representing the formatted output of `input`.
         *        Passed by move.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API FormattedPlaceholder(const FormattedPlaceholder& input, FormattedValue&& output)
            : fallback(input.fallback), source(input.source),
            formatted(std::move(output)), previousOptions(FunctionOptions()), type(kEvaluated) {}
        /**
         * Constructor for fully formatted placeholders with options.
         *
         * @param input A `FormattedPlaceholder` containing the fallback string and source
         *        `Formattable` used to construct the formatted value.
         * @param opts Function options that were used to construct `output`. May be the empty map.
         * @param output A `FormattedValue` representing the formatted output of `input`.
         *        Passed by move.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API FormattedPlaceholder(const FormattedPlaceholder& input, FunctionOptions&& opts, FormattedValue&& output)
            : fallback(input.fallback), source(input.source),
            formatted(std::move(output)), previousOptions(std::move(opts)), type(kEvaluated) {}
        /**
         * Constructor for unformatted placeholders.
         *
         * @param input A `Formattable` object.
         * @param fb Fallback string to use if an error occurs while formatting the input.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API FormattedPlaceholder(const Formattable& input, const UnicodeString& fb)
            : fallback(fb), source(input), type(kUnevaluated) {}
        /**
         * Default constructor. Leaves the FormattedPlaceholder in a
         * valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API FormattedPlaceholder() : type(kNull) {}
        /**
         * Returns the source `Formattable` value for this placeholder.
         * The result is undefined if this is a null operand.
         *
         * @return A message2::Formattable value.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const message2::Formattable& asFormattable() const;
        /**
         * Returns true iff this is a fallback placeholder.
         *
         * @return True if and only if this placeholder was constructed from a fallback string,
         *         with no `Formattable` source or formatting output.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API bool isFallback() const { return type == kFallback; }
        /**
         * Returns true iff this is a null placeholder.
         *
         * @return True if and only if this placeholder represents the absent argument to a formatter
         *         that was invoked without an argument.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API bool isNullOperand() const { return type == kNull; }
        /**
         * Returns true iff this has formatting output.
         *
         * @return True if and only if this was constructed from both an input `Formattable` and
         *         output `FormattedValue`.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API bool isEvaluated() const { return (type == kEvaluated); }
        /**
         * Returns true iff this represents a valid argument to the formatter.
         *
         * @return True if and only if this is neither the null argument nor a fallback placeholder.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API bool canFormat() const { return !(isFallback() || isNullOperand()); }
        /**
         * Gets the fallback value of this placeholder, to be used in its place if an error occurs while
         * formatting it.
         * @return          A reference to this placeholder's fallback string.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const UnicodeString& getFallback() const { return fallback; }
        /**
         * Returns the options of this placeholder. The result is the empty map if !isEvaluated().
         * @return A reference to an option map, capturing the options that were used
         *         in producing the output of this `FormattedPlaceholder`
         *         (or empty if there is no output)
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const FunctionOptions& options() const { return previousOptions; }
        /**
         * Returns the formatted output of this placeholder. The result is undefined if !isEvaluated().
         * @return          A fully formatted `FormattedPlaceholder`.
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const FormattedValue& output() const { return formatted; }
        /**
         * Move assignment operator:
         * The source FormattedPlaceholder will be left in a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API FormattedPlaceholder& operator=(FormattedPlaceholder&&) noexcept;
        /**
         * Move constructor:
         * The source FormattedPlaceholder will be left in a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API FormattedPlaceholder(FormattedPlaceholder&& other) { *this = std::move(other); }
        /**
         * Formats this as a string, using defaults.  If this is
         * either the null operand or is a fallback value, the return value is the result of formatting the
         * fallback value (which is the default fallback string if this is the null operand).
         * If there is no formatted output and the input is object- or array-typed,
         * then the argument is treated as a fallback value, since there is no default formatter
         * for objects or arrays.
         *
         * @param locale The locale to use for formatting numbers or dates
         * @param status Input/output error code
         * @return The result of formatting this placeholder.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API UnicodeString formatToString(const Locale& locale,
                                     UErrorCode& status) const;

    private:
        friend class MessageFormatter;

        enum Type {
            kFallback,    // Represents the result of formatting that encountered an error
            kNull,        // Represents the absence of both an output and an input (not necessarily an error)
            kUnevaluated, // `source` should be valid, but there's no result yet
            kEvaluated,   // `formatted` exists
        };
        UnicodeString fallback;
        Formattable source;
        FormattedValue formatted;
        FunctionOptions previousOptions; // Ignored unless type is kEvaluated
        Type type;
    }; // class FormattedPlaceholder

    /**
     * Not yet implemented: The result of a message formatting operation. Based on
     * ICU4J's FormattedMessage.java.
     *
     * The class will contain information allowing the result to be viewed as a string,
     * iterator, etc. (TBD)
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API FormattedMessage : public icu::FormattedValue {
    public:
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        FormattedMessage(UErrorCode& status) {
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
        }
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        int32_t length(UErrorCode& status) const {
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return -1;
        }
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        char16_t charAt(int32_t index, UErrorCode& status) const {
            (void) index;
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return 0;
        }
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        StringPiece subSequence(int32_t start, int32_t end, UErrorCode& status) const {
            (void) start;
            (void) end;
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return "";
        }
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        UnicodeString toString(UErrorCode& status) const override {
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return {};
        }
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        UnicodeString toTempString(UErrorCode& status) const override {
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return {};
        }
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        Appendable& appendTo(Appendable& appendable, UErrorCode& status) const override {
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return appendable;
        }
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        UBool nextPosition(ConstrainedFieldPosition& cfpos, UErrorCode& status) const override {
            (void) cfpos;
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return false;
        }
        /**
         * Not yet implemented.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        CharacterIterator* toCharacterIterator(UErrorCode& status) {
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return nullptr;
        }
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for ICU internal use only.
         */
        virtual ~FormattedMessage();
    }; // class FormattedMessage

} // namespace message2

U_NAMESPACE_END

#endif // U_HIDE_DEPRECATED_API

#endif /* #if !UCONFIG_NO_MF2 */

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* #if !UCONFIG_NO_NORMALIZATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // MESSAGEFORMAT2_FORMATTABLE_H

// eof
