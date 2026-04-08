package main

import "testing"

func TestParseTaggedDocumentAcceptsMissingBodyCloseAtEOF(t *testing.T) {
	t.Parallel()

	input := "<frontmatter>\ntitle: Test\n</frontmatter>\n<body>\nTranslated body\n"

	front, body, err := parseTaggedDocument(input)
	if err != nil {
		t.Fatalf("parseTaggedDocument returned error: %v", err)
	}
	if front != "title: Test" {
		t.Fatalf("unexpected frontmatter %q", front)
	}
	if body != "Translated body" {
		t.Fatalf("unexpected body %q", body)
	}
}

func TestParseTaggedDocumentRejectsTrailingTextOutsideTags(t *testing.T) {
	t.Parallel()

	input := "<frontmatter>\ntitle: Test\n</frontmatter>\n<body>\nTranslated body\n</body>\nextra"

	_, _, err := parseTaggedDocument(input)
	if err == nil {
		t.Fatal("expected error for trailing text")
	}
}
