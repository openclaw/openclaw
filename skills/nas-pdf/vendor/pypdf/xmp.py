"""
Anything related to Extensible Metadata Platform (XMP) metadata.

https://en.wikipedia.org/wiki/Extensible_Metadata_Platform
"""

import datetime
import decimal
import re
from collections.abc import Iterator
from typing import (
    Any,
    Callable,
    Optional,
    TypeVar,
    Union,
)
from xml.dom.minidom import Document, parseString
from xml.dom.minidom import Element as XmlElement
from xml.parsers.expat import ExpatError

from ._protocols import XmpInformationProtocol
from ._utils import StreamType, deprecate_with_replacement, deprecation_no_replacement
from .errors import PdfReadError, XmpDocumentError
from .generic import ContentStream, PdfObject

RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DC_NAMESPACE = "http://purl.org/dc/elements/1.1/"
XMP_NAMESPACE = "http://ns.adobe.com/xap/1.0/"
PDF_NAMESPACE = "http://ns.adobe.com/pdf/1.3/"
XMPMM_NAMESPACE = "http://ns.adobe.com/xap/1.0/mm/"

# What is the PDFX namespace, you might ask?
# It's documented here: https://github.com/adobe/xmp-docs/raw/master/XMPSpecifications/XMPSpecificationPart3.pdf
# This namespace is used to place "custom metadata"
# properties, which are arbitrary metadata properties with no semantic or
# documented meaning.
#
# Elements in the namespace are key/value-style storage,
# where the element name is the key and the content is the value. The keys
# are transformed into valid XML identifiers by substituting an invalid
# identifier character with \u2182 followed by the unicode hex ID of the
# original character. A key like "my car" is therefore "my\u21820020car".
#
# \u2182 is the unicode character \u{ROMAN NUMERAL TEN THOUSAND}
#
# The pdfx namespace should be avoided.
# A custom data schema and sensical XML elements could be used instead, as is
# suggested by Adobe's own documentation on XMP under "Extensibility of
# Schemas".
PDFX_NAMESPACE = "http://ns.adobe.com/pdfx/1.3/"

# PDF/A
PDFAID_NAMESPACE = "http://www.aiim.org/pdfa/ns/id/"

# Internal mapping of namespace URI → prefix
_NAMESPACE_PREFIX_MAP = {
    DC_NAMESPACE: "dc",
    XMP_NAMESPACE: "xmp",
    PDF_NAMESPACE: "pdf",
    XMPMM_NAMESPACE: "xmpMM",
    PDFAID_NAMESPACE: "pdfaid",
    PDFX_NAMESPACE: "pdfx",
}

iso8601 = re.compile(
    """
        (?P<year>[0-9]{4})
        (-
            (?P<month>[0-9]{2})
            (-
                (?P<day>[0-9]+)
                (T
                    (?P<hour>[0-9]{2}):
                    (?P<minute>[0-9]{2})
                    (:(?P<second>[0-9]{2}(.[0-9]+)?))?
                    (?P<tzd>Z|[-+][0-9]{2}:[0-9]{2})
                )?
            )?
        )?
        """,
    re.VERBOSE,
)


K = TypeVar("K")

# Minimal XMP template
_MINIMAL_XMP = f"""<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="pypdf">
    <rdf:RDF xmlns:rdf="{RDF_NAMESPACE}">
        <rdf:Description rdf:about=""
            xmlns:dc="{DC_NAMESPACE}"
            xmlns:xmp="{XMP_NAMESPACE}"
            xmlns:pdf="{PDF_NAMESPACE}"
            xmlns:xmpMM="{XMPMM_NAMESPACE}"
            xmlns:pdfaid="{PDFAID_NAMESPACE}"
            xmlns:pdfx="{PDFX_NAMESPACE}">
        </rdf:Description>
    </rdf:RDF>
</x:xmpmeta>
<?xpacket end="r"?>"""


def _identity(value: K) -> K:
    return value


def _converter_date(value: str) -> datetime.datetime:
    matches = iso8601.match(value)
    if matches is None:
        raise ValueError(f"Invalid date format: {value}")
    year = int(matches.group("year"))
    month = int(matches.group("month") or "1")
    day = int(matches.group("day") or "1")
    hour = int(matches.group("hour") or "0")
    minute = int(matches.group("minute") or "0")
    second = decimal.Decimal(matches.group("second") or "0")
    seconds_dec = second.to_integral(decimal.ROUND_FLOOR)
    milliseconds_dec = (second - seconds_dec) * 1_000_000

    seconds = int(seconds_dec)
    milliseconds = int(milliseconds_dec)

    tzd = matches.group("tzd") or "Z"
    dt = datetime.datetime(year, month, day, hour, minute, seconds, milliseconds)
    if tzd != "Z":
        tzd_hours, tzd_minutes = (int(x) for x in tzd.split(":"))
        tzd_hours *= -1
        if tzd_hours < 0:
            tzd_minutes *= -1
        dt = dt + datetime.timedelta(hours=tzd_hours, minutes=tzd_minutes)
    return dt


def _format_datetime_utc(value: datetime.datetime) -> str:
    """Format a datetime as UTC with trailing 'Z'.

    - If the input is timezone-aware, convert to UTC first.
    - If naive, assume UTC.
    """
    if value.tzinfo is not None and value.utcoffset() is not None:
        value = value.astimezone(datetime.timezone.utc)

    value = value.replace(tzinfo=None)
    return value.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _generic_get(
        element: XmlElement, self: "XmpInformation", list_type: str, converter: Callable[[Any], Any] = _identity
) -> Optional[list[str]]:
    containers = element.getElementsByTagNameNS(RDF_NAMESPACE, list_type)
    retval: list[Any] = []
    if len(containers):
        for container in containers:
            for item in container.getElementsByTagNameNS(RDF_NAMESPACE, "li"):
                value = self._get_text(item)
                value = converter(value)
                retval.append(value)
        return retval
    return None


class XmpInformation(XmpInformationProtocol, PdfObject):
    """
    An object that represents Extensible Metadata Platform (XMP) metadata.
    Usually accessed by :py:attr:`xmp_metadata()<pypdf.PdfReader.xmp_metadata>`.

    Raises:
      PdfReadError: if XML is invalid

    """

    def __init__(self, stream: ContentStream) -> None:
        self.stream = stream
        try:
            data = self.stream.get_data()
            doc_root: Document = parseString(data)  # noqa: S318
        except (AttributeError, ExpatError) as e:
            raise PdfReadError(f"XML in XmpInformation was invalid: {e}")
        self.rdf_root: XmlElement = doc_root.getElementsByTagNameNS(
            RDF_NAMESPACE, "RDF"
        )[0]
        self.cache: dict[Any, Any] = {}

    @classmethod
    def create(cls) -> "XmpInformation":
        """
        Create a new XmpInformation object with minimal structure.

        Returns:
            A new XmpInformation instance with empty metadata fields.
        """
        stream = ContentStream(None, None)
        stream.set_data(_MINIMAL_XMP.encode("utf-8"))
        return cls(stream)

    def write_to_stream(
        self, stream: StreamType, encryption_key: Union[None, str, bytes] = None
    ) -> None:
        deprecate_with_replacement(
            "XmpInformation.write_to_stream",
            "PdfWriter.xmp_metadata",
            "6.0.0"
        )
        if encryption_key is not None:  # deprecated
            deprecation_no_replacement(
                "the encryption_key parameter of write_to_stream", "5.0.0"
            )
        self.stream.write_to_stream(stream)

    def get_element(self, about_uri: str, namespace: str, name: str) -> Iterator[Any]:
        for desc in self.rdf_root.getElementsByTagNameNS(RDF_NAMESPACE, "Description"):
            if desc.getAttributeNS(RDF_NAMESPACE, "about") == about_uri:
                attr = desc.getAttributeNodeNS(namespace, name)
                if attr is not None:
                    yield attr
                yield from desc.getElementsByTagNameNS(namespace, name)

    def get_nodes_in_namespace(self, about_uri: str, namespace: str) -> Iterator[Any]:
        for desc in self.rdf_root.getElementsByTagNameNS(RDF_NAMESPACE, "Description"):
            if desc.getAttributeNS(RDF_NAMESPACE, "about") == about_uri:
                for i in range(desc.attributes.length):
                    attr = desc.attributes.item(i)
                    if attr and attr.namespaceURI == namespace:
                        yield attr
                for child in desc.childNodes:
                    if child.namespaceURI == namespace:
                        yield child

    def _get_text(self, element: XmlElement) -> str:
        text = ""
        for child in element.childNodes:
            if child.nodeType == child.TEXT_NODE:
                text += child.data
        return text

    def _get_single_value(
        self,
        namespace: str,
        name: str,
        converter: Callable[[str], Any] = _identity,
    ) -> Optional[Any]:
        cached = self.cache.get(namespace, {}).get(name)
        if cached:
            return cached
        value = None
        for element in self.get_element("", namespace, name):
            if element.nodeType == element.ATTRIBUTE_NODE:
                value = element.nodeValue
            else:
                value = self._get_text(element)
            break
        if value is not None:
            value = converter(value)
        ns_cache = self.cache.setdefault(namespace, {})
        ns_cache[name] = value
        return value

    def _getter_bag(self, namespace: str, name: str) -> Optional[list[str]]:
        cached = self.cache.get(namespace, {}).get(name)
        if cached:
            return cached
        retval: list[str] = []
        for element in self.get_element("", namespace, name):
            if (bags := _generic_get(element, self, list_type="Bag")) is not None:
                retval.extend(bags)
            else:
                value = self._get_text(element)
                retval.append(value)
        ns_cache = self.cache.setdefault(namespace, {})
        ns_cache[name] = retval
        return retval

    def _get_seq_values(
        self,
        namespace: str,
        name: str,
        converter: Callable[[Any], Any] = _identity,
    ) -> Optional[list[Any]]:
        cached = self.cache.get(namespace, {}).get(name)
        if cached:
            return cached
        retval: list[Any] = []
        for element in self.get_element("", namespace, name):
            if (seqs := _generic_get(element, self, list_type="Seq", converter=converter)) is not None:
                retval.extend(seqs)
            elif (bags := _generic_get(element, self, list_type="Bag")) is not None:
                # See issue at https://github.com/py-pdf/pypdf/issues/3324
                # Some applications violate the XMP metadata standard regarding `dc:creator` which should
                # be an "ordered array" and thus a sequence, but use an unordered array (bag) instead.
                # This seems to stem from the fact that the original Dublin Core specification does indeed
                # use bags or direct values, while PDFs are expected to follow the XMP standard and ignore
                # the plain Dublin Core variant. For this reason, add a fallback here to deal with such
                # issues accordingly.
                retval.extend(bags)
            else:
                value = converter(self._get_text(element))
                retval.append(value)
        ns_cache = self.cache.setdefault(namespace, {})
        ns_cache[name] = retval
        return retval

    def _get_langalt_values(self, namespace: str, name: str) -> Optional[dict[Any, Any]]:
        cached = self.cache.get(namespace, {}).get(name)
        if cached:
            return cached
        retval: dict[Any, Any] = {}
        for element in self.get_element("", namespace, name):
            alts = element.getElementsByTagNameNS(RDF_NAMESPACE, "Alt")
            if len(alts):
                for alt in alts:
                    for item in alt.getElementsByTagNameNS(RDF_NAMESPACE, "li"):
                        value = self._get_text(item)
                        retval[item.getAttribute("xml:lang")] = value
            else:
                retval["x-default"] = self._get_text(element)
        ns_cache = self.cache.setdefault(namespace, {})
        ns_cache[name] = retval
        return retval

    @property
    def dc_contributor(self) -> Optional[list[str]]:
        """Contributors to the resource (other than the authors)."""
        return self._getter_bag(DC_NAMESPACE, "contributor")

    @dc_contributor.setter
    def dc_contributor(self, values: Optional[list[str]]) -> None:
        self._set_bag_values(DC_NAMESPACE, "contributor", values)

    @property
    def dc_coverage(self) -> Optional[str]:
        """Text describing the extent or scope of the resource."""
        return self._get_single_value(DC_NAMESPACE, "coverage")

    @dc_coverage.setter
    def dc_coverage(self, value: Optional[str]) -> None:
        self._set_single_value(DC_NAMESPACE, "coverage", value)

    @property
    def dc_creator(self) -> Optional[list[str]]:
        """A sorted array of names of the authors of the resource, listed in order of precedence."""
        return self._get_seq_values(DC_NAMESPACE, "creator")

    @dc_creator.setter
    def dc_creator(self, values: Optional[list[str]]) -> None:
        self._set_seq_values(DC_NAMESPACE, "creator", values)

    @property
    def dc_date(self) -> Optional[list[datetime.datetime]]:
        """A sorted array of dates of significance to the resource. The dates and times are in UTC."""
        return self._get_seq_values(DC_NAMESPACE, "date", _converter_date)

    @dc_date.setter
    def dc_date(self, values: Optional[list[Union[str, datetime.datetime]]]) -> None:
        if values is None:
            self._set_seq_values(DC_NAMESPACE, "date", None)
        else:
            date_strings = []
            for value in values:
                if isinstance(value, datetime.datetime):
                    date_strings.append(_format_datetime_utc(value))
                else:
                    date_strings.append(str(value))
            self._set_seq_values(DC_NAMESPACE, "date", date_strings)

    @property
    def dc_description(self) -> Optional[dict[str, str]]:
        """A language-keyed dictionary of textual descriptions of the content of the resource."""
        return self._get_langalt_values(DC_NAMESPACE, "description")

    @dc_description.setter
    def dc_description(self, values: Optional[dict[str, str]]) -> None:
        self._set_langalt_values(DC_NAMESPACE, "description", values)

    @property
    def dc_format(self) -> Optional[str]:
        """The mime-type of the resource."""
        return self._get_single_value(DC_NAMESPACE, "format")

    @dc_format.setter
    def dc_format(self, value: Optional[str]) -> None:
        self._set_single_value(DC_NAMESPACE, "format", value)

    @property
    def dc_identifier(self) -> Optional[str]:
        """Unique identifier of the resource."""
        return self._get_single_value(DC_NAMESPACE, "identifier")

    @dc_identifier.setter
    def dc_identifier(self, value: Optional[str]) -> None:
        self._set_single_value(DC_NAMESPACE, "identifier", value)

    @property
    def dc_language(self) -> Optional[list[str]]:
        """An unordered array specifying the languages used in the resource."""
        return self._getter_bag(DC_NAMESPACE, "language")

    @dc_language.setter
    def dc_language(self, values: Optional[list[str]]) -> None:
        self._set_bag_values(DC_NAMESPACE, "language", values)

    @property
    def dc_publisher(self) -> Optional[list[str]]:
        """An unordered array of publisher names."""
        return self._getter_bag(DC_NAMESPACE, "publisher")

    @dc_publisher.setter
    def dc_publisher(self, values: Optional[list[str]]) -> None:
        self._set_bag_values(DC_NAMESPACE, "publisher", values)

    @property
    def dc_relation(self) -> Optional[list[str]]:
        """An unordered array of text descriptions of relationships to other documents."""
        return self._getter_bag(DC_NAMESPACE, "relation")

    @dc_relation.setter
    def dc_relation(self, values: Optional[list[str]]) -> None:
        self._set_bag_values(DC_NAMESPACE, "relation", values)

    @property
    def dc_rights(self) -> Optional[dict[str, str]]:
        """A language-keyed dictionary of textual descriptions of the rights the user has to this resource."""
        return self._get_langalt_values(DC_NAMESPACE, "rights")

    @dc_rights.setter
    def dc_rights(self, values: Optional[dict[str, str]]) -> None:
        self._set_langalt_values(DC_NAMESPACE, "rights", values)

    @property
    def dc_source(self) -> Optional[str]:
        """Unique identifier of the work from which this resource was derived."""
        return self._get_single_value(DC_NAMESPACE, "source")

    @dc_source.setter
    def dc_source(self, value: Optional[str]) -> None:
        self._set_single_value(DC_NAMESPACE, "source", value)

    @property
    def dc_subject(self) -> Optional[list[str]]:
        """An unordered array of descriptive phrases or keywords that specify the topic of the content."""
        return self._getter_bag(DC_NAMESPACE, "subject")

    @dc_subject.setter
    def dc_subject(self, values: Optional[list[str]]) -> None:
        self._set_bag_values(DC_NAMESPACE, "subject", values)

    @property
    def dc_title(self) -> Optional[dict[str, str]]:
        """A language-keyed dictionary of the title of the resource."""
        return self._get_langalt_values(DC_NAMESPACE, "title")

    @dc_title.setter
    def dc_title(self, values: Optional[dict[str, str]]) -> None:
        self._set_langalt_values(DC_NAMESPACE, "title", values)

    @property
    def dc_type(self) -> Optional[list[str]]:
        """An unordered array of textual descriptions of the document type."""
        return self._getter_bag(DC_NAMESPACE, "type")

    @dc_type.setter
    def dc_type(self, values: Optional[list[str]]) -> None:
        self._set_bag_values(DC_NAMESPACE, "type", values)

    @property
    def pdf_keywords(self) -> Optional[str]:
        """An unformatted text string representing document keywords."""
        return self._get_single_value(PDF_NAMESPACE, "Keywords")

    @pdf_keywords.setter
    def pdf_keywords(self, value: Optional[str]) -> None:
        self._set_single_value(PDF_NAMESPACE, "Keywords", value)

    @property
    def pdf_pdfversion(self) -> Optional[str]:
        """The PDF file version, for example 1.0 or 1.3."""
        return self._get_single_value(PDF_NAMESPACE, "PDFVersion")

    @pdf_pdfversion.setter
    def pdf_pdfversion(self, value: Optional[str]) -> None:
        self._set_single_value(PDF_NAMESPACE, "PDFVersion", value)

    @property
    def pdf_producer(self) -> Optional[str]:
        """The name of the tool that saved the document as a PDF."""
        return self._get_single_value(PDF_NAMESPACE, "Producer")

    @pdf_producer.setter
    def pdf_producer(self, value: Optional[str]) -> None:
        self._set_single_value(PDF_NAMESPACE, "Producer", value)

    @property
    def xmp_create_date(self) -> Optional[datetime.datetime]:
        """The date and time the resource was originally created. Returned as a UTC datetime object."""
        return self._get_single_value(XMP_NAMESPACE, "CreateDate", _converter_date)

    @xmp_create_date.setter
    def xmp_create_date(self, value: Optional[datetime.datetime]) -> None:
        if value:
            date_str = _format_datetime_utc(value)
            self._set_single_value(XMP_NAMESPACE, "CreateDate", date_str)
        else:
            self._set_single_value(XMP_NAMESPACE, "CreateDate", None)

    @property
    def xmp_modify_date(self) -> Optional[datetime.datetime]:
        """The date and time the resource was last modified. Returned as a UTC datetime object."""
        return self._get_single_value(XMP_NAMESPACE, "ModifyDate", _converter_date)

    @xmp_modify_date.setter
    def xmp_modify_date(self, value: Optional[datetime.datetime]) -> None:
        if value:
            date_str = _format_datetime_utc(value)
            self._set_single_value(XMP_NAMESPACE, "ModifyDate", date_str)
        else:
            self._set_single_value(XMP_NAMESPACE, "ModifyDate", None)

    @property
    def xmp_metadata_date(self) -> Optional[datetime.datetime]:
        """The date and time that any metadata for this resource was last changed. Returned as a UTC datetime object."""
        return self._get_single_value(XMP_NAMESPACE, "MetadataDate", _converter_date)

    @xmp_metadata_date.setter
    def xmp_metadata_date(self, value: Optional[datetime.datetime]) -> None:
        if value:
            date_str = _format_datetime_utc(value)
            self._set_single_value(XMP_NAMESPACE, "MetadataDate", date_str)
        else:
            self._set_single_value(XMP_NAMESPACE, "MetadataDate", None)

    @property
    def xmp_creator_tool(self) -> Optional[str]:
        """The name of the first known tool used to create the resource."""
        return self._get_single_value(XMP_NAMESPACE, "CreatorTool")

    @xmp_creator_tool.setter
    def xmp_creator_tool(self, value: Optional[str]) -> None:
        self._set_single_value(XMP_NAMESPACE, "CreatorTool", value)

    @property
    def xmpmm_document_id(self) -> Optional[str]:
        """The common identifier for all versions and renditions of this resource."""
        return self._get_single_value(XMPMM_NAMESPACE, "DocumentID")

    @xmpmm_document_id.setter
    def xmpmm_document_id(self, value: Optional[str]) -> None:
        self._set_single_value(XMPMM_NAMESPACE, "DocumentID", value)

    @property
    def xmpmm_instance_id(self) -> Optional[str]:
        """An identifier for a specific incarnation of a document, updated each time a file is saved."""
        return self._get_single_value(XMPMM_NAMESPACE, "InstanceID")

    @xmpmm_instance_id.setter
    def xmpmm_instance_id(self, value: Optional[str]) -> None:
        self._set_single_value(XMPMM_NAMESPACE, "InstanceID", value)

    @property
    def pdfaid_part(self) -> Optional[str]:
        """The part of the PDF/A standard that the document conforms to (e.g., 1, 2, 3)."""
        return self._get_single_value(PDFAID_NAMESPACE, "part")

    @pdfaid_part.setter
    def pdfaid_part(self, value: Optional[str]) -> None:
        self._set_single_value(PDFAID_NAMESPACE, "part", value)

    @property
    def pdfaid_conformance(self) -> Optional[str]:
        """The conformance level within the PDF/A standard (e.g., 'A', 'B', 'U')."""
        return self._get_single_value(PDFAID_NAMESPACE, "conformance")

    @pdfaid_conformance.setter
    def pdfaid_conformance(self, value: Optional[str]) -> None:
        self._set_single_value(PDFAID_NAMESPACE, "conformance", value)

    @property
    def custom_properties(self) -> dict[Any, Any]:
        """
        Retrieve custom metadata properties defined in the undocumented pdfx
        metadata schema.

        Returns:
            A dictionary of key/value items for custom metadata properties.

        """
        if not hasattr(self, "_custom_properties"):
            self._custom_properties = {}
            for node in self.get_nodes_in_namespace("", PDFX_NAMESPACE):
                key = node.localName
                while True:
                    # see documentation about PDFX_NAMESPACE earlier in file
                    idx = key.find("\u2182")
                    if idx == -1:
                        break
                    key = (
                        key[:idx]
                        + chr(int(key[idx + 1 : idx + 5], base=16))
                        + key[idx + 5 :]
                    )
                if node.nodeType == node.ATTRIBUTE_NODE:
                    value = node.nodeValue
                else:
                    value = self._get_text(node)
                self._custom_properties[key] = value
        return self._custom_properties

    def _get_or_create_description(self, about_uri: str = "") -> XmlElement:
        """Get or create an rdf:Description element with the given about URI."""
        for desc in self.rdf_root.getElementsByTagNameNS(RDF_NAMESPACE, "Description"):
            if desc.getAttributeNS(RDF_NAMESPACE, "about") == about_uri:
                return desc

        doc = self.rdf_root.ownerDocument
        if doc is None:
            raise XmpDocumentError("XMP Document is None")
        desc = doc.createElementNS(RDF_NAMESPACE, "rdf:Description")
        desc.setAttributeNS(RDF_NAMESPACE, "rdf:about", about_uri)
        self.rdf_root.appendChild(desc)
        return desc

    def _clear_cache_entry(self, namespace: str, name: str) -> None:
        """Remove a cached value for a given namespace/name if present."""
        ns_cache = self.cache.get(namespace)
        if ns_cache and name in ns_cache:
            del ns_cache[name]

    def _set_single_value(self, namespace: str, name: str, value: Optional[str]) -> None:
        """Set or remove a single metadata value."""
        self._clear_cache_entry(namespace, name)
        desc = self._get_or_create_description()

        existing_elements = list(desc.getElementsByTagNameNS(namespace, name))
        for elem in existing_elements:
            desc.removeChild(elem)

        if existing_attr := desc.getAttributeNodeNS(namespace, name):
            desc.removeAttributeNode(existing_attr)

        if value is not None:
            doc = self.rdf_root.ownerDocument
            if doc is None:
                raise XmpDocumentError("XMP Document is None")
            prefix = self._get_namespace_prefix(namespace)
            elem = doc.createElementNS(namespace, f"{prefix}:{name}")
            text_node = doc.createTextNode(str(value))
            elem.appendChild(text_node)
            desc.appendChild(elem)

        self._update_stream()

    def _set_bag_values(self, namespace: str, name: str, values: Optional[list[str]]) -> None:
        """Set or remove bag values (unordered array)."""
        self._clear_cache_entry(namespace, name)
        desc = self._get_or_create_description()

        existing_elements = list(desc.getElementsByTagNameNS(namespace, name))
        for elem in existing_elements:
            desc.removeChild(elem)

        if values:
            doc = self.rdf_root.ownerDocument
            if doc is None:
                raise XmpDocumentError("XMP Document is None")
            prefix = self._get_namespace_prefix(namespace)
            elem = doc.createElementNS(namespace, f"{prefix}:{name}")
            bag = doc.createElementNS(RDF_NAMESPACE, "rdf:Bag")

            for value in values:
                li = doc.createElementNS(RDF_NAMESPACE, "rdf:li")
                text_node = doc.createTextNode(str(value))
                li.appendChild(text_node)
                bag.appendChild(li)

            elem.appendChild(bag)
            desc.appendChild(elem)

        self._update_stream()

    def _set_seq_values(self, namespace: str, name: str, values: Optional[list[str]]) -> None:
        """Set or remove sequence values (ordered array)."""
        self._clear_cache_entry(namespace, name)
        desc = self._get_or_create_description()

        existing_elements = list(desc.getElementsByTagNameNS(namespace, name))
        for elem in existing_elements:
            desc.removeChild(elem)

        if values:
            doc = self.rdf_root.ownerDocument
            if doc is None:
                raise XmpDocumentError("XMP Document is None")
            prefix = self._get_namespace_prefix(namespace)
            elem = doc.createElementNS(namespace, f"{prefix}:{name}")
            seq = doc.createElementNS(RDF_NAMESPACE, "rdf:Seq")

            for value in values:
                li = doc.createElementNS(RDF_NAMESPACE, "rdf:li")
                text_node = doc.createTextNode(str(value))
                li.appendChild(text_node)
                seq.appendChild(li)

            elem.appendChild(seq)
            desc.appendChild(elem)

        self._update_stream()

    def _set_langalt_values(self, namespace: str, name: str, values: Optional[dict[str, str]]) -> None:
        """Set or remove language alternative values."""
        self._clear_cache_entry(namespace, name)
        desc = self._get_or_create_description()

        existing_elements = list(desc.getElementsByTagNameNS(namespace, name))
        for elem in existing_elements:
            desc.removeChild(elem)

        if values:
            doc = self.rdf_root.ownerDocument
            if doc is None:
                raise XmpDocumentError("XMP Document is None")
            prefix = self._get_namespace_prefix(namespace)
            elem = doc.createElementNS(namespace, f"{prefix}:{name}")
            alt = doc.createElementNS(RDF_NAMESPACE, "rdf:Alt")

            for lang, value in values.items():
                li = doc.createElementNS(RDF_NAMESPACE, "rdf:li")
                li.setAttribute("xml:lang", lang)
                text_node = doc.createTextNode(str(value))
                li.appendChild(text_node)
                alt.appendChild(li)

            elem.appendChild(alt)
            desc.appendChild(elem)

        self._update_stream()

    def _get_namespace_prefix(self, namespace: str) -> str:
        """Get the appropriate namespace prefix for a given namespace URI."""
        return _NAMESPACE_PREFIX_MAP.get(namespace, "unknown")

    def _update_stream(self) -> None:
        """Update the stream with the current XML content."""
        doc = self.rdf_root.ownerDocument
        if doc is None:
            raise XmpDocumentError("XMP Document is None")

        xml_data = doc.toxml(encoding="utf-8")
        self.stream.set_data(xml_data)
