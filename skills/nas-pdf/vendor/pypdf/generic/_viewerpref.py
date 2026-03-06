# Copyright (c) 2023, Pubpub-ZZ
#
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are
# met:
#
# * Redistributions of source code must retain the above copyright notice,
# this list of conditions and the following disclaimer.
# * Redistributions in binary form must reproduce the above copyright notice,
# this list of conditions and the following disclaimer in the documentation
# and/or other materials provided with the distribution.
# * The name of the author may not be used to endorse or promote products
# derived from this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.

from typing import (
    Any,
    Optional,
)

from ._base import BooleanObject, NameObject, NumberObject, is_null_or_none
from ._data_structures import ArrayObject, DictionaryObject

f_obj = BooleanObject(False)


class ViewerPreferences(DictionaryObject):
    def __init__(self, obj: Optional[DictionaryObject] = None) -> None:
        super().__init__(self)
        if not is_null_or_none(obj):
            self.update(obj.items())  # type: ignore
        try:
            self.indirect_reference = obj.indirect_reference  # type: ignore
        except AttributeError:
            pass

    def _get_bool(self, key: str, default: Optional[BooleanObject]) -> Optional[BooleanObject]:
        return self.get(key, default)

    def _set_bool(self, key: str, v: bool) -> None:
        self[NameObject(key)] = BooleanObject(v is True)

    def _get_name(self, key: str, default: Optional[NameObject]) -> Optional[NameObject]:
        return self.get(key, default)

    def _set_name(self, key: str, lst: list[str], v: NameObject) -> None:
        if v[0] != "/":
            raise ValueError(f"{v} does not start with '/'")
        if lst != [] and v not in lst:
            raise ValueError(f"{v} is an unacceptable value")
        self[NameObject(key)] = NameObject(v)

    def _get_arr(self, key: str, default: Optional[list[Any]]) -> Optional[ArrayObject]:
        return self.get(key, None if default is None else ArrayObject(default))

    def _set_arr(self, key: str, v: Optional[ArrayObject]) -> None:
        if v is None:
            try:
                del self[NameObject(key)]
            except KeyError:
                pass
            return
        if not isinstance(v, ArrayObject):
            raise ValueError("ArrayObject is expected")
        self[NameObject(key)] = v

    def _get_int(self, key: str, default: Optional[NumberObject]) -> Optional[NumberObject]:
        return self.get(key, default)

    def _set_int(self, key: str, v: int) -> None:
        self[NameObject(key)] = NumberObject(v)

    @property
    def PRINT_SCALING(self) -> NameObject:
        return NameObject("/PrintScaling")

    def __new__(cls: Any, value: Any = None) -> "ViewerPreferences":  # noqa: PYI034
        def _add_prop_bool(key: str, default: Optional[BooleanObject]) -> property:
            return property(
                lambda self: self._get_bool(key, default),
                lambda self, v: self._set_bool(key, v),
                None,
                f"""
            Returns/Modify the status of {key}, Returns {default} if not defined
            """,
            )

        def _add_prop_name(
            key: str, lst: list[str], default: Optional[NameObject]
        ) -> property:
            return property(
                lambda self: self._get_name(key, default),
                lambda self, v: self._set_name(key, lst, v),
                None,
                f"""
            Returns/Modify the status of {key}, Returns {default} if not defined.
            Acceptable values: {lst}
            """,
            )

        def _add_prop_arr(key: str, default: Optional[ArrayObject]) -> property:
            return property(
                lambda self: self._get_arr(key, default),
                lambda self, v: self._set_arr(key, v),
                None,
                f"""
            Returns/Modify the status of {key}, Returns {default} if not defined
            """,
            )

        def _add_prop_int(key: str, default: Optional[int]) -> property:
            return property(
                lambda self: self._get_int(key, default),
                lambda self, v: self._set_int(key, v),
                None,
                f"""
            Returns/Modify the status of {key}, Returns {default} if not defined
            """,
            )

        cls.hide_toolbar = _add_prop_bool("/HideToolbar", f_obj)
        cls.hide_menubar = _add_prop_bool("/HideMenubar", f_obj)
        cls.hide_windowui = _add_prop_bool("/HideWindowUI", f_obj)
        cls.fit_window = _add_prop_bool("/FitWindow", f_obj)
        cls.center_window = _add_prop_bool("/CenterWindow", f_obj)
        cls.display_doctitle = _add_prop_bool("/DisplayDocTitle", f_obj)

        cls.non_fullscreen_pagemode = _add_prop_name(
            "/NonFullScreenPageMode",
            ["/UseNone", "/UseOutlines", "/UseThumbs", "/UseOC"],
            NameObject("/UseNone"),
        )
        cls.direction = _add_prop_name(
            "/Direction", ["/L2R", "/R2L"], NameObject("/L2R")
        )
        cls.view_area = _add_prop_name("/ViewArea", [], None)
        cls.view_clip = _add_prop_name("/ViewClip", [], None)
        cls.print_area = _add_prop_name("/PrintArea", [], None)
        cls.print_clip = _add_prop_name("/PrintClip", [], None)
        cls.print_scaling = _add_prop_name("/PrintScaling", [], None)
        cls.duplex = _add_prop_name(
            "/Duplex", ["/Simplex", "/DuplexFlipShortEdge", "/DuplexFlipLongEdge"], None
        )
        cls.pick_tray_by_pdfsize = _add_prop_bool("/PickTrayByPDFSize", None)
        cls.print_pagerange = _add_prop_arr("/PrintPageRange", None)
        cls.num_copies = _add_prop_int("/NumCopies", None)

        cls.enforce = _add_prop_arr("/Enforce", ArrayObject())

        return DictionaryObject.__new__(cls)
