"""Various constants, enums, and flags to aid readability."""

from enum import Enum, IntFlag, auto, unique


class StrEnum(str, Enum):  # Once we are on Python 3.11+: enum.StrEnum
    def __str__(self) -> str:
        return str(self.value)


class Core:
    """Keywords that don't quite belong anywhere else."""

    OUTLINES = "/Outlines"
    THREADS = "/Threads"
    PAGE = "/Page"
    PAGES = "/Pages"
    CATALOG = "/Catalog"


class TrailerKeys:
    SIZE = "/Size"
    PREV = "/Prev"
    ROOT = "/Root"
    ENCRYPT = "/Encrypt"
    INFO = "/Info"
    ID = "/ID"


class CatalogAttributes:
    NAMES = "/Names"
    DESTS = "/Dests"


class EncryptionDictAttributes:
    """
    Additional encryption dictionary entries for the standard security handler.

    Table 3.19, Page 122.
    Table 21 of the 2.0 manual.
    """

    R = "/R"  # number, required; revision of the standard security handler
    O = "/O"  # 32-byte string, required  # noqa: E741
    U = "/U"  # 32-byte string, required
    P = "/P"  # integer flag, required; permitted operations
    ENCRYPT_METADATA = "/EncryptMetadata"  # boolean flag, optional


class UserAccessPermissions(IntFlag):
    """
    Table 3.20 User access permissions.
    Table 22 of the 2.0 manual.
    """

    R1 = 1
    R2 = 2
    PRINT = 4
    MODIFY = 8
    EXTRACT = 16
    ADD_OR_MODIFY = 32
    R7 = 64
    R8 = 128
    FILL_FORM_FIELDS = 256
    EXTRACT_TEXT_AND_GRAPHICS = 512
    ASSEMBLE_DOC = 1024
    PRINT_TO_REPRESENTATION = 2048
    R13 = 2**12
    R14 = 2**13
    R15 = 2**14
    R16 = 2**15
    R17 = 2**16
    R18 = 2**17
    R19 = 2**18
    R20 = 2**19
    R21 = 2**20
    R22 = 2**21
    R23 = 2**22
    R24 = 2**23
    R25 = 2**24
    R26 = 2**25
    R27 = 2**26
    R28 = 2**27
    R29 = 2**28
    R30 = 2**29
    R31 = 2**30
    R32 = 2**31

    @classmethod
    def _is_reserved(cls, name: str) -> bool:
        """Check if the given name corresponds to a reserved flag entry."""
        return name.startswith("R") and name[1:].isdigit()

    @classmethod
    def _is_active(cls, name: str) -> bool:
        """Check if the given reserved name defaults to 1 = active."""
        return name not in {"R1", "R2"}

    def to_dict(self) -> dict[str, bool]:
        """Convert the given flag value to a corresponding verbose name mapping."""
        result: dict[str, bool] = {}
        for name, flag in UserAccessPermissions.__members__.items():
            if UserAccessPermissions._is_reserved(name):
                continue
            result[name.lower()] = (self & flag) == flag
        return result

    @classmethod
    def from_dict(cls, value: dict[str, bool]) -> "UserAccessPermissions":
        """Convert the verbose name mapping to the corresponding flag value."""
        value_copy = value.copy()
        result = cls(0)
        for name, flag in cls.__members__.items():
            if cls._is_reserved(name):
                # Reserved names have a required value. Use it.
                if cls._is_active(name):
                    result |= flag
                continue
            is_active = value_copy.pop(name.lower(), False)
            if is_active:
                result |= flag
        if value_copy:
            raise ValueError(f"Unknown dictionary keys: {value_copy!r}")
        return result

    @classmethod
    def all(cls) -> "UserAccessPermissions":
        return cls((2**32 - 1) - cls.R1 - cls.R2)


class Resources:
    """
    Table 3.30 Entries in a resource dictionary.
    Table 34 in the 2.0 reference.
    """

    EXT_G_STATE = "/ExtGState"  # dictionary, optional
    COLOR_SPACE = "/ColorSpace"  # dictionary, optional
    PATTERN = "/Pattern"  # dictionary, optional
    SHADING = "/Shading"  # dictionary, optional
    XOBJECT = "/XObject"  # dictionary, optional
    FONT = "/Font"  # dictionary, optional
    PROC_SET = "/ProcSet"  # array, optional
    PROPERTIES = "/Properties"  # dictionary, optional


class PagesAttributes:
    """§7.7.3.2 of the 1.7 and 2.0 reference."""

    TYPE = "/Type"  # name, required; must be /Pages
    PARENT = "/Parent"  # dictionary, required; indirect reference to pages object
    KIDS = "/Kids"  # array, required; List of indirect references
    COUNT = "/Count"
    # integer, required; the number of leaf nodes (page objects)
    # that are descendants of this node within the page tree


class PageAttributes:
    """§7.7.3.3 of the 1.7 and 2.0 reference."""

    TYPE = "/Type"  # name, required; must be /Page
    PARENT = "/Parent"  # dictionary, required; a pages object
    LAST_MODIFIED = (
        "/LastModified"  # date, optional; date and time of last modification
    )
    RESOURCES = "/Resources"  # dictionary, required if there are any
    MEDIABOX = "/MediaBox"  # rectangle, required; rectangle specifying page size
    CROPBOX = "/CropBox"  # rectangle, optional
    BLEEDBOX = "/BleedBox"  # rectangle, optional
    TRIMBOX = "/TrimBox"  # rectangle, optional
    ARTBOX = "/ArtBox"  # rectangle, optional
    BOX_COLOR_INFO = "/BoxColorInfo"  # dictionary, optional
    CONTENTS = "/Contents"  # stream or array, optional
    ROTATE = "/Rotate"  # integer, optional; page rotation in degrees
    GROUP = "/Group"  # dictionary, optional; page group
    THUMB = "/Thumb"  # stream, optional; indirect reference to image of the page
    B = "/B"  # array, optional
    DUR = "/Dur"  # number, optional
    TRANS = "/Trans"  # dictionary, optional
    ANNOTS = "/Annots"  # array, optional; an array of annotations
    AA = "/AA"  # dictionary, optional
    METADATA = "/Metadata"  # stream, optional
    PIECE_INFO = "/PieceInfo"  # dictionary, optional
    STRUCT_PARENTS = "/StructParents"  # integer, optional
    ID = "/ID"  # byte string, optional
    PZ = "/PZ"  # number, optional
    SEPARATION_INFO = "/SeparationInfo"  # dictionary, optional
    TABS = "/Tabs"  # name, optional
    TEMPLATE_INSTANTIATED = "/TemplateInstantiated"  # name, optional
    PRES_STEPS = "/PresSteps"  # dictionary, optional
    USER_UNIT = "/UserUnit"  # number, optional
    VP = "/VP"  # dictionary, optional
    AF = "/AF"  # array of dictionaries, optional
    OUTPUT_INTENTS = "/OutputIntents"  # array, optional
    D_PART = "/DPart"  # dictionary, required, if this page is within the range of a DPart, not permitted otherwise


class FileSpecificationDictionaryEntries:
    """Table 3.41 Entries in a file specification dictionary."""

    Type = "/Type"
    FS = "/FS"  # The name of the file system to be used to interpret this file specification
    F = "/F"  # A file specification string of the form described in §3.10.1
    UF = "/UF"  # A Unicode string of the file as described in §3.10.1
    DOS = "/DOS"
    Mac = "/Mac"
    Unix = "/Unix"
    ID = "/ID"
    V = "/V"
    EF = "/EF"  # dictionary, containing a subset of the keys F, UF, DOS, Mac, and Unix
    RF = "/RF"  # dictionary, containing arrays of /EmbeddedFile
    DESC = "/Desc"  # description of the file
    Cl = "/Cl"


class StreamAttributes:
    """
    Table 4.2.
    Table 5 in the 2.0 reference.
    """

    LENGTH = "/Length"  # integer, required
    FILTER = "/Filter"  # name or array of names, optional
    DECODE_PARMS = "/DecodeParms"  # variable, optional -- 'decodeParams is wrong


@unique
class FilterTypes(StrEnum):
    """§7.4 of the 1.7 and 2.0 references."""

    ASCII_HEX_DECODE = "/ASCIIHexDecode"  # abbreviation: AHx
    ASCII_85_DECODE = "/ASCII85Decode"  # abbreviation: A85
    LZW_DECODE = "/LZWDecode"  # abbreviation: LZW
    FLATE_DECODE = "/FlateDecode"  # abbreviation: Fl
    RUN_LENGTH_DECODE = "/RunLengthDecode"  # abbreviation: RL
    CCITT_FAX_DECODE = "/CCITTFaxDecode"  # abbreviation: CCF
    DCT_DECODE = "/DCTDecode"  # abbreviation: DCT
    JPX_DECODE = "/JPXDecode"
    JBIG2_DECODE = "/JBIG2Decode"


class FilterTypeAbbreviations:
    """§8.9.7 of the 1.7 and 2.0 references."""

    AHx = "/AHx"
    A85 = "/A85"
    LZW = "/LZW"
    FL = "/Fl"
    RL = "/RL"
    CCF = "/CCF"
    DCT = "/DCT"


class LzwFilterParameters:
    """
    Table 4.4.
    Table 8 in the 2.0 reference.
    """

    PREDICTOR = "/Predictor"  # integer
    COLORS = "/Colors"  # integer
    BITS_PER_COMPONENT = "/BitsPerComponent"  # integer
    COLUMNS = "/Columns"  # integer
    EARLY_CHANGE = "/EarlyChange"  # integer


class CcittFaxDecodeParameters:
    """
    Table 4.5.
    Table 11 in the 2.0 reference.
    """

    K = "/K"  # integer
    END_OF_LINE = "/EndOfLine"  # boolean
    ENCODED_BYTE_ALIGN = "/EncodedByteAlign"  # boolean
    COLUMNS = "/Columns"  # integer
    ROWS = "/Rows"  # integer
    END_OF_BLOCK = "/EndOfBlock"  # boolean
    BLACK_IS_1 = "/BlackIs1"  # boolean
    DAMAGED_ROWS_BEFORE_ERROR = "/DamagedRowsBeforeError"  # integer


class ImageAttributes:
    """§11.6.5 of the 1.7 and 2.0 references."""

    TYPE = "/Type"  # name, required; must be /XObject
    SUBTYPE = "/Subtype"  # name, required; must be /Image
    NAME = "/Name"  # name, required
    WIDTH = "/Width"  # integer, required
    HEIGHT = "/Height"  # integer, required
    BITS_PER_COMPONENT = "/BitsPerComponent"  # integer, required
    COLOR_SPACE = "/ColorSpace"  # name, required
    DECODE = "/Decode"  # array, optional
    INTENT = "/Intent"  # string, optional
    INTERPOLATE = "/Interpolate"  # boolean, optional
    IMAGE_MASK = "/ImageMask"  # boolean, optional
    MASK = "/Mask"  # 1-bit image mask stream
    S_MASK = "/SMask"  # dictionary or name, optional


class ColorSpaces:
    DEVICE_RGB = "/DeviceRGB"
    DEVICE_CMYK = "/DeviceCMYK"
    DEVICE_GRAY = "/DeviceGray"


class TypArguments:
    """Table 8.2 of the PDF 1.7 reference."""

    LEFT = "/Left"
    RIGHT = "/Right"
    BOTTOM = "/Bottom"
    TOP = "/Top"


class TypFitArguments:
    """Table 8.2 of the PDF 1.7 reference."""

    XYZ = "/XYZ"
    FIT = "/Fit"
    FIT_H = "/FitH"
    FIT_V = "/FitV"
    FIT_R = "/FitR"
    FIT_B = "/FitB"
    FIT_BH = "/FitBH"
    FIT_BV = "/FitBV"


class GoToActionArguments:
    S = "/S"  # name, required: type of action
    D = "/D"  # name, byte string, or array, required: destination to jump to
    SD = "/SD"  # array, optional: structure destination to jump to


class AnnotationDictionaryAttributes:
    """Table 8.15 Entries common to all annotation dictionaries."""

    Type = "/Type"
    Subtype = "/Subtype"
    Rect = "/Rect"
    Contents = "/Contents"
    P = "/P"
    NM = "/NM"
    M = "/M"
    F = "/F"
    AP = "/AP"
    AS = "/AS"
    DA = "/DA"
    Border = "/Border"
    C = "/C"
    StructParent = "/StructParent"
    OC = "/OC"


class InteractiveFormDictEntries:
    Fields = "/Fields"
    NeedAppearances = "/NeedAppearances"
    SigFlags = "/SigFlags"
    CO = "/CO"
    DR = "/DR"
    DA = "/DA"
    Q = "/Q"
    XFA = "/XFA"


class FieldDictionaryAttributes:
    """
    Entries common to all field dictionaries (Table 8.69 PDF 1.7 reference)
    (*very partially documented here*).

    FFBits provides the constants used for `/Ff` from Table 8.70/8.75/8.77/8.79
    """

    FT = "/FT"  # name, required for terminal fields
    Parent = "/Parent"  # dictionary, required for children
    Kids = "/Kids"  # array, sometimes required
    T = "/T"  # text string, optional
    TU = "/TU"  # text string, optional
    TM = "/TM"  # text string, optional
    Ff = "/Ff"  # integer, optional
    V = "/V"  # text string or array, optional
    DV = "/DV"  # text string, optional
    AA = "/AA"  # dictionary, optional
    Opt = "/Opt"  # array, optional

    class FfBits(IntFlag):
        """
        Ease building /Ff flags
        Some entries may be specific to:

        * Text (Tx) (Table 8.75 PDF 1.7 reference)
        * Buttons (Btn) (Table 8.77 PDF 1.7 reference)
        * Choice (Ch) (Table 8.79 PDF 1.7 reference)
        """

        ReadOnly = 1 << 0
        """common to Tx/Btn/Ch in Table 8.70"""
        Required = 1 << 1
        """common to Tx/Btn/Ch in Table 8.70"""
        NoExport = 1 << 2
        """common to Tx/Btn/Ch in Table 8.70"""

        Multiline = 1 << 12
        """Tx"""
        Password = 1 << 13
        """Tx"""

        NoToggleToOff = 1 << 14
        """Btn"""
        Radio = 1 << 15
        """Btn"""
        Pushbutton = 1 << 16
        """Btn"""

        Combo = 1 << 17
        """Ch"""
        Edit = 1 << 18
        """Ch"""
        Sort = 1 << 19
        """Ch"""

        FileSelect = 1 << 20
        """Tx"""

        MultiSelect = 1 << 21
        """Tx"""

        DoNotSpellCheck = 1 << 22
        """Tx/Ch"""
        DoNotScroll = 1 << 23
        """Tx"""
        Comb = 1 << 24
        """Tx"""

        RadiosInUnison = 1 << 25
        """Btn"""

        RichText = 1 << 25
        """Tx"""

        CommitOnSelChange = 1 << 26
        """Ch"""

    @classmethod
    def attributes(cls) -> tuple[str, ...]:
        """
        Get a tuple of all the attributes present in a Field Dictionary.

        This method returns a tuple of all the attribute constants defined in
        the FieldDictionaryAttributes class. These attributes correspond to the
        entries that are common to all field dictionaries as specified in the
        PDF 1.7 reference.

        Returns:
            A tuple containing all the attribute constants.

        """
        return (
            cls.TM,
            cls.T,
            cls.FT,
            cls.Parent,
            cls.TU,
            cls.Ff,
            cls.V,
            cls.DV,
            cls.Kids,
            cls.AA,
        )

    @classmethod
    def attributes_dict(cls) -> dict[str, str]:
        """
        Get a dictionary of attribute keys and their human-readable names.

        This method returns a dictionary where the keys are the attribute
        constants defined in the FieldDictionaryAttributes class and the values
        are their corresponding human-readable names. These attributes
        correspond to the entries that are common to all field dictionaries as
        specified in the PDF 1.7 reference.

        Returns:
            A dictionary containing attribute keys and their names.

        """
        return {
            cls.FT: "Field Type",
            cls.Parent: "Parent",
            cls.T: "Field Name",
            cls.TU: "Alternate Field Name",
            cls.TM: "Mapping Name",
            cls.Ff: "Field Flags",
            cls.V: "Value",
            cls.DV: "Default Value",
        }


class CheckboxRadioButtonAttributes:
    """Table 8.76 Field flags common to all field types."""

    Opt = "/Opt"  # Options, Optional

    @classmethod
    def attributes(cls) -> tuple[str, ...]:
        """
        Get a tuple of all the attributes present in a Field Dictionary.

        This method returns a tuple of all the attribute constants defined in
        the CheckboxRadioButtonAttributes class. These attributes correspond to
        the entries that are common to all field dictionaries as specified in
        the PDF 1.7 reference.

        Returns:
            A tuple containing all the attribute constants.

        """
        return (cls.Opt,)

    @classmethod
    def attributes_dict(cls) -> dict[str, str]:
        """
        Get a dictionary of attribute keys and their human-readable names.

        This method returns a dictionary where the keys are the attribute
        constants defined in the CheckboxRadioButtonAttributes class and the
        values are their corresponding human-readable names. These attributes
        correspond to the entries that are common to all field dictionaries as
        specified in the PDF 1.7 reference.

        Returns:
            A dictionary containing attribute keys and their names.

        """
        return {
            cls.Opt: "Options",
        }


class FieldFlag(IntFlag):
    """Table 8.70 Field flags common to all field types."""

    READ_ONLY = 1
    REQUIRED = 2
    NO_EXPORT = 4


class DocumentInformationAttributes:
    """Table 10.2 Entries in the document information dictionary."""

    TITLE = "/Title"  # text string, optional
    AUTHOR = "/Author"  # text string, optional
    SUBJECT = "/Subject"  # text string, optional
    KEYWORDS = "/Keywords"  # text string, optional
    CREATOR = "/Creator"  # text string, optional
    PRODUCER = "/Producer"  # text string, optional
    CREATION_DATE = "/CreationDate"  # date, optional
    MOD_DATE = "/ModDate"  # date, optional
    TRAPPED = "/Trapped"  # name, optional


class PageLayouts:
    """
    Page 84, PDF 1.4 reference.
    Page 115, PDF 2.0 reference.
    """

    SINGLE_PAGE = "/SinglePage"
    ONE_COLUMN = "/OneColumn"
    TWO_COLUMN_LEFT = "/TwoColumnLeft"
    TWO_COLUMN_RIGHT = "/TwoColumnRight"
    TWO_PAGE_LEFT = "/TwoPageLeft"  # (PDF 1.5)
    TWO_PAGE_RIGHT = "/TwoPageRight"  # (PDF 1.5)


class GraphicsStateParameters:
    """Table 58 – Entries in a Graphics State Parameter Dictionary"""

    TYPE = "/Type"  # name, optional
    LW = "/LW"  # number, optional
    LC = "/LC"  # integer, optional
    LJ = "/LJ"  # integer, optional
    ML = "/ML"  # number, optional
    D = "/D"  # array, optional
    RI = "/RI"  # name, optional
    OP = "/OP"
    op = "/op"
    OPM = "/OPM"
    FONT = "/Font"  # array, optional
    BG = "/BG"
    BG2 = "/BG2"
    UCR = "/UCR"
    UCR2 = "/UCR2"
    TR = "/TR"
    TR2 = "/TR2"
    HT = "/HT"
    FL = "/FL"
    SM = "/SM"
    SA = "/SA"
    BM = "/BM"
    S_MASK = "/SMask"  # dictionary or name, optional
    CA = "/CA"
    ca = "/ca"
    AIS = "/AIS"
    TK = "/TK"


class CatalogDictionary:
    """§7.7.2 of the 1.7 and 2.0 references."""

    TYPE = "/Type"  # name, required; must be /Catalog
    VERSION = "/Version"  # name
    EXTENSIONS = "/Extensions"  # dictionary, optional; ISO 32000-1
    PAGES = "/Pages"  # dictionary, required
    PAGE_LABELS = "/PageLabels"  # number tree, optional
    NAMES = "/Names"  # dictionary, optional
    DESTS = "/Dests"  # dictionary, optional
    VIEWER_PREFERENCES = "/ViewerPreferences"  # dictionary, optional
    PAGE_LAYOUT = "/PageLayout"  # name, optional
    PAGE_MODE = "/PageMode"  # name, optional
    OUTLINES = "/Outlines"  # dictionary, optional
    THREADS = "/Threads"  # array, optional
    OPEN_ACTION = "/OpenAction"  # array or dictionary or name, optional
    AA = "/AA"  # dictionary, optional
    URI = "/URI"  # dictionary, optional
    ACRO_FORM = "/AcroForm"  # dictionary, optional
    METADATA = "/Metadata"  # stream, optional
    STRUCT_TREE_ROOT = "/StructTreeRoot"  # dictionary, optional
    MARK_INFO = "/MarkInfo"  # dictionary, optional
    LANG = "/Lang"  # text string, optional
    SPIDER_INFO = "/SpiderInfo"  # dictionary, optional
    OUTPUT_INTENTS = "/OutputIntents"  # array, optional
    PIECE_INFO = "/PieceInfo"  # dictionary, optional
    OC_PROPERTIES = "/OCProperties"  # dictionary, optional
    PERMS = "/Perms"  # dictionary, optional
    LEGAL = "/Legal"  # dictionary, optional
    REQUIREMENTS = "/Requirements"  # array, optional
    COLLECTION = "/Collection"  # dictionary, optional
    NEEDS_RENDERING = "/NeedsRendering"  # boolean, optional
    DSS = "/DSS"  # dictionary, optional
    AF = "/AF"  # array of dictionaries, optional
    D_PART_ROOT = "/DPartRoot"  # dictionary, optional


class OutlineFontFlag(IntFlag):
    """A class used as an enumerable flag for formatting an outline font."""

    italic = 1
    bold = 2


class PageLabelStyle:
    """
    Table 8.10 in the 1.7 reference.
    Table 161 in the 2.0 reference.
    """

    DECIMAL = "/D"  # Decimal Arabic numerals
    UPPERCASE_ROMAN = "/R"  # Uppercase Roman numerals
    LOWERCASE_ROMAN = "/r"  # Lowercase Roman numerals
    UPPERCASE_LETTER = "/A"  # Uppercase letters
    LOWERCASE_LETTER = "/a"  # Lowercase letters


class AnnotationFlag(IntFlag):
    """See §12.5.3 "Annotation Flags"."""

    INVISIBLE = 1
    HIDDEN = 2
    PRINT = 4
    NO_ZOOM = 8
    NO_ROTATE = 16
    NO_VIEW = 32
    READ_ONLY = 64
    LOCKED = 128
    TOGGLE_NO_VIEW = 256
    LOCKED_CONTENTS = 512


PDF_KEYS = (
    AnnotationDictionaryAttributes,
    CatalogAttributes,
    CatalogDictionary,
    CcittFaxDecodeParameters,
    CheckboxRadioButtonAttributes,
    ColorSpaces,
    Core,
    DocumentInformationAttributes,
    EncryptionDictAttributes,
    FieldDictionaryAttributes,
    FileSpecificationDictionaryEntries,
    FilterTypeAbbreviations,
    FilterTypes,
    GoToActionArguments,
    GraphicsStateParameters,
    ImageAttributes,
    InteractiveFormDictEntries,
    LzwFilterParameters,
    PageAttributes,
    PageLayouts,
    PagesAttributes,
    Resources,
    StreamAttributes,
    TrailerKeys,
    TypArguments,
    TypFitArguments,
)


class ImageType(IntFlag):
    NONE = 0
    XOBJECT_IMAGES = auto()
    INLINE_IMAGES = auto()
    DRAWING_IMAGES = auto()
    ALL = XOBJECT_IMAGES | INLINE_IMAGES | DRAWING_IMAGES
    IMAGES = ALL  # for consistency with ObjectDeletionFlag


_INLINE_IMAGE_VALUE_MAPPING = {
    "/G": "/DeviceGray",
    "/RGB": "/DeviceRGB",
    "/CMYK": "/DeviceCMYK",
    "/I": "/Indexed",
    "/AHx": "/ASCIIHexDecode",
    "/A85": "/ASCII85Decode",
    "/LZW": "/LZWDecode",
    "/Fl": "/FlateDecode",
    "/RL": "/RunLengthDecode",
    "/CCF": "/CCITTFaxDecode",
    "/DCT": "/DCTDecode",
    "/DeviceGray": "/DeviceGray",
    "/DeviceRGB": "/DeviceRGB",
    "/DeviceCMYK": "/DeviceCMYK",
    "/Indexed": "/Indexed",
    "/ASCIIHexDecode": "/ASCIIHexDecode",
    "/ASCII85Decode": "/ASCII85Decode",
    "/LZWDecode": "/LZWDecode",
    "/FlateDecode": "/FlateDecode",
    "/RunLengthDecode": "/RunLengthDecode",
    "/CCITTFaxDecode": "/CCITTFaxDecode",
    "/DCTDecode": "/DCTDecode",
    "/RelativeColorimetric": "/RelativeColorimetric",
}

_INLINE_IMAGE_KEY_MAPPING = {
    "/BPC": "/BitsPerComponent",
    "/CS": "/ColorSpace",
    "/D": "/Decode",
    "/DP": "/DecodeParms",
    "/F": "/Filter",
    "/H": "/Height",
    "/W": "/Width",
    "/I": "/Interpolate",
    "/Intent": "/Intent",
    "/IM": "/ImageMask",
    "/BitsPerComponent": "/BitsPerComponent",
    "/ColorSpace": "/ColorSpace",
    "/Decode": "/Decode",
    "/DecodeParms": "/DecodeParms",
    "/Filter": "/Filter",
    "/Height": "/Height",
    "/Width": "/Width",
    "/Interpolate": "/Interpolate",
    "/ImageMask": "/ImageMask",
}


class AFRelationship:
    """
    Associated file relationship types, defining the relationship between
    the PDF component and the associated file.

    Defined in table 43 of the PDF 2.0 reference.
    """

    SOURCE = "/Source"  # Original content source
    DATA = "/Data"  # Base data for visual presentation
    ALTERNATIVE = "/Alternative"  # Alternative content representation
    SUPPLEMENT = "/Supplement"  # Supplemental representation of original source/data
    ENCRYPTED_PAYLOAD = "/EncryptedPayload"  # Encrypted payload document
    FORM_DATA = "/FormData"  # Data associated with AcroForm of this PDF
    SCHEMA = "/Schema"  # Schema definition for associated object
    UNSPECIFIED = "/Unspecified"  # Not known or cannot be described with values


class BorderStyles:
    """
    A class defining border styles used in PDF documents.

    Defined in table 168 of the PDF 2.0 reference.
    """

    BEVELED = "/B"
    DASHED = "/D"
    INSET = "/I"
    SOLID = "/S"
    UNDERLINED = "/U"


class FontFlags(IntFlag):
    """
    A class defining font flags in PDF document font descriptor resources.

    Defined in table 121 of the PDF 2.0 reference.
    """

    FIXED_PITCH = 1 << 0
    SERIF = 1 << 1
    SYMBOLIC = 1 << 2
    SCRIPT = 1 << 3
    NONSYMBOLIC = 1 << 5
    ITALIC = 1 << 6
    ALL_CAP = 1 << 16
    SMALL_CAP = 1 << 17
    FORCE_BOLD = 1 << 18
