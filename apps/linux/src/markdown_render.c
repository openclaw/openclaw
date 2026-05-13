/*
 * markdown_render.c
 * Description: Markdown-to-Pango rendering helpers used by chat message views.
 * Author: Thiago Camargo <thiagocmc@proton.me>
 */

#include "markdown_render.h"

#include <string.h>

static void append_escaped_char(GString *out, gchar c) {
    switch (c) {
    case '&': g_string_append(out, "&amp;"); break;
    case '<': g_string_append(out, "&lt;"); break;
    case '>': g_string_append(out, "&gt;"); break;
    case '\'': g_string_append(out, "&apos;"); break;
    case '"': g_string_append(out, "&quot;"); break;
    default: g_string_append_c(out, c); break;
    }
}

gchar* markdown_escape_pango(const gchar *text) {
    if (!text) return g_strdup("");
    GString *out = g_string_new(NULL);
    for (const gchar *p = text; *p; p++) {
        append_escaped_char(out, *p);
    }
    return g_string_free(out, FALSE);
}

static gchar* markdown_inline_to_pango(const gchar *line) {
    GString *out = g_string_new(NULL);
    gboolean in_bold = FALSE;
    gboolean in_italic = FALSE;
    gboolean in_code = FALSE;

    for (gsize i = 0; line && line[i] != '\0'; i++) {
        if (!in_code && line[i] == '*' && line[i + 1] == '*') {
            g_string_append(out, in_bold ? "</b>" : "<b>");
            in_bold = !in_bold;
            i++;
            continue;
        }
        if (!in_code && line[i] == '*') {
            g_string_append(out, in_italic ? "</i>" : "<i>");
            in_italic = !in_italic;
            continue;
        }
        if (line[i] == '`') {
            g_string_append(out, in_code ? "</tt>" : "<tt>");
            in_code = !in_code;
            continue;
        }

        append_escaped_char(out, line[i]);
    }

    if (in_code) g_string_append(out, "</tt>");
    if (in_italic) g_string_append(out, "</i>");
    if (in_bold) g_string_append(out, "</b>");
    return g_string_free(out, FALSE);
}

gchar* markdown_to_pango(const gchar *markdown) {
    if (!markdown || markdown[0] == '\0') return g_strdup("");

    g_auto(GStrv) lines = g_strsplit(markdown, "\n", -1);
    GString *out = g_string_new(NULL);

    for (gint i = 0; lines[i] != NULL; i++) {
        const gchar *line = lines[i];
        if (i > 0) g_string_append_c(out, '\n');

        const gchar *content = line;
        const gchar *prefix = NULL;

        if (g_str_has_prefix(line, "# ")) {
            prefix = "<span size=\"xx-large\"><b>";
            content = line + 2;
        } else if (g_str_has_prefix(line, "## ")) {
            prefix = "<span size=\"x-large\"><b>";
            content = line + 3;
        } else if (g_str_has_prefix(line, "### ")) {
            prefix = "<span size=\"large\"><b>";
            content = line + 4;
        } else if (g_str_has_prefix(line, "- ")) {
            g_string_append(out, " • ");
            content = line + 2;
        }

        g_autofree gchar *inline_markup = markdown_inline_to_pango(content);

        if (prefix) {
            g_string_append(out, prefix);
            g_string_append(out, inline_markup);
            g_string_append(out, "</b></span>");
        } else {
            g_string_append(out, inline_markup);
        }
    }

    while (out->len > 0 && out->str[out->len - 1] == '\n') {
        g_string_truncate(out, out->len - 1);
    }

    return g_string_free(out, FALSE);
}
