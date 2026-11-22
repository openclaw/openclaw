import { describe, expect, it, vi } from "vitest";
import { extractBalancedJsonFragments } from "./balanced-json.js";

describe("balanced JSON extraction", () => {
  const strictRecovery = { strictJson: true, recoverAtLineStart: true } as const;

  it("retires indexed owners at original endpoints across artificial descendants", () => {
    for (const source of [
      '["]"]',
      '[" ] ",{}]',
      '{"x":"}","ok":true}',
      '[{"x":"]","ok":true}]',
      '["[",{}]',
      '["{",{}]',
      '{"x":"[","child":{"ok":true}}',
    ]) {
      const opaqueSpans = Array.from(source.matchAll(/"/g), ({ index }) => ({
        startIndex: index,
        endIndex: index,
      }));
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          expect(
            extractBalancedJsonFragments(raw, {
              recoverAtLineStart,
              strictJson: { source, opaqueSpans },
            }),
          ).toEqual([{ json: source, startIndex: 0, endIndex: source.length - 1 }]);
        }
      }
    }
    const source = '["text"]';
    expect(
      extractBalancedJsonFragments(source, {
        ...strictRecovery,
        strictJson: { source, opaqueSpans: [{ startIndex: 1, endIndex: 1 }] },
      }),
    ).toEqual([{ json: source, startIndex: 0, endIndex: source.length - 1 }]);
    // A discovery mask preserves the original opening quote. Unlike accepted
    // framing, it therefore makes the later closing-quote span an inside entry.
    expect(
      extractBalancedJsonFragments('[ ]"]', {
        ...strictRecovery,
        strictJson: {
          source: '["]"]',
          opaqueSpans: [{ startIndex: 3, endIndex: 4 }],
        },
      }),
    ).toEqual([{ json: '["]"]', startIndex: 0, endIndex: 4 }]);
  });

  it("keeps crossing indexed candidates independent of filtered discovery ancestors", () => {
    const parent = '["[",{"]":1}]';
    const child = '{"]":1}';
    const suffix = '{"after":true}';
    for (const separator of ["", "\n", "\r\n", "\r"]) {
      const source = parent + separator + suffix;
      const opaqueSpans = [
        { startIndex: 1, endIndex: 1 },
        { startIndex: 3, endIndex: 3 },
      ];
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          const options = { recoverAtLineStart, strictJson: { source, opaqueSpans } };
          const fragment = (json: string) => ({
            json,
            startIndex: source.indexOf(json),
            endIndex: source.indexOf(json) + json.length - 1,
          });
          expect(extractBalancedJsonFragments(raw, { ...options, openers: ["{"] })).toEqual([
            fragment(child),
            fragment(suffix),
          ]);
          expect(extractBalancedJsonFragments(raw, options)).toEqual([
            fragment(parent),
            fragment(suffix),
          ]);
        }
      }
    }
  });

  it("uses original string ownership for opaque entry after hidden opening quotes", () => {
    for (const text of ["text", "]", 'escaped " quote']) {
      const parent = `[${JSON.stringify(text)}]`;
      const suffix = '{"after":true}';
      const source = parent + "] " + suffix;
      const endpoint = parent.length - 1;
      const opaqueSpans = [{ startIndex: endpoint, endIndex: endpoint }];
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          expect(
            extractBalancedJsonFragments(raw, {
              recoverAtLineStart,
              strictJson: { source, opaqueSpans },
            }),
          ).toEqual([
            {
              json: suffix,
              startIndex: parent.length + 2,
              endIndex: source.length - 1,
            },
          ]);
        }
      }
    }
  });

  it("releases expired indexed protection after a hidden endpoint without admitting its owner", () => {
    for (const prefix of ["{}}", "[]]"]) {
      for (const separator of ["", "\n", "\r\n", "\r"]) {
        const first = '{"first":1}';
        const second = '{"second":2}';
        const source = `${prefix}${separator}${first} ${second}`;
        const expected = [first, second].map((json) => ({
          json,
          startIndex: source.indexOf(json),
          endIndex: source.indexOf(json) + json.length - 1,
        }));
        for (const raw of [source, `${source[0]} ${source.slice(2)}`]) {
          for (const recoverAtLineStart of [false, true]) {
            expect(
              extractBalancedJsonFragments(raw, {
                recoverAtLineStart,
                strictJson: {
                  source,
                  opaqueSpans: [{ startIndex: 1, endIndex: 1 }],
                },
              }),
            ).toEqual(expected);
          }
        }
      }
    }
  });

  it("separates original lexical owners from crossing emission candidates", () => {
    // Discovery masks preserve source quotes. Atomic framing removes their
    // participation, so exposing both crossing candidates covers both quotes.
    const cases = [
      { source: '["{",{}]', quotes: [], intervals: [[5, 6]] },
      {
        source: '["{",{":1}":true}]',
        quotes: [1, 3],
        intervals: [
          [2, 9],
          [5, 16],
        ],
      },
      {
        source: '["{",{":0}":1}]',
        quotes: [1, 3],
        intervals: [
          [2, 9],
          [5, 13],
        ],
      },
      { source: '["[","]{}"]', quotes: [], intervals: [] },
    ] as const;
    for (const { source, quotes, intervals } of cases) {
      const opaqueSpans = quotes.map((index) => ({ startIndex: index, endIndex: index }));
      for (const raw of [source, source.replaceAll('"', " ")]) {
        for (const recoverAtLineStart of [false, true]) {
          expect(
            extractBalancedJsonFragments(raw, {
              openers: ["{"],
              recoverAtLineStart,
              strictJson: { source, opaqueSpans },
            }),
          ).toEqual(
            intervals.map(([startIndex, endIndex]) => ({
              json: source.slice(startIndex, endIndex + 1),
              startIndex,
              endIndex,
            })),
          );
        }
      }
    }
  });

  it("retains original string entry ownership for malformed and hidden containers", () => {
    const suffix = '{"after":true}';
    for (const newline of ["\n", "\r\n", "\r"]) {
      for (const prefix of ['["text",]', `["line one${newline}line two"]`]) {
        const source = prefix + newline + suffix;
        // Hiding source quotes in discovery is not declaring them framing.
        const opaqueSpans = [{ startIndex: 3, endIndex: source.length - 1 }];
        for (const raw of [source, source.replaceAll('"', " ")]) {
          for (const recoverAtLineStart of [false, true]) {
            expect(
              extractBalancedJsonFragments(raw, {
                recoverAtLineStart,
                strictJson: { source, opaqueSpans },
              }),
            ).toEqual([
              {
                json: suffix,
                startIndex: prefix.length + newline.length,
                endIndex: source.length - 1,
              },
            ]);
          }
        }
      }
    }
    const source = '["text"]{}';
    for (const recoverAtLineStart of [false, true]) {
      expect(
        extractBalancedJsonFragments("  " + source.slice(2), {
          recoverAtLineStart,
          strictJson: {
            source,
            opaqueSpans: [{ startIndex: 2, endIndex: source.length - 1 }],
          },
        }),
      ).toEqual([{ json: "{}", startIndex: 8, endIndex: 9 }]);
    }
  });

  it("retires hidden endpoints before adjacent records or multiline prose quotes", () => {
    const suffix = '{"after":true}';
    for (const parent of ["[]", "{}"]) {
      for (const separator of [" ", "\n", "\r\n", "\r"]) {
        for (const prose of ["", '"line one\n[0] line two" ']) {
          const source = parent + separator + prose + suffix;
          for (const recoverAtLineStart of [false, true]) {
            expect(
              extractBalancedJsonFragments(source, {
                recoverAtLineStart,
                strictJson: { source, opaqueSpans: [{ startIndex: 1, endIndex: 1 }] },
              }),
            ).toEqual([
              {
                json: suffix,
                startIndex: source.length - suffix.length,
                endIndex: source.length - 1,
              },
            ]);
          }
        }
      }
    }
  });

  it("keeps hidden malformed lexical owners separate from warning delimiters", () => {
    const after = '{"after":1}';
    for (const parent of ['["text",]', '{"text":}']) {
      for (const separator of [" ", "\n", "\r\n", "\r"]) {
        for (const recoverAtLineStart of [false, true]) {
          for (const spanMode of ["inside-string", "visible-end", "masked-end"]) {
            const prose = spanMode === "inside-string" ? "" : '"prose\n[0]\nend" ';
            const source = parent + separator + prose + after;
            const opaqueSpans =
              spanMode === "inside-string" ? [{ startIndex: 2, endIndex: source.length - 3 }] : [];
            const masked = source
              .split("")
              .map((char, index) =>
                index <= 1 ||
                (spanMode === "masked-end" && index === parent.length - 1) ||
                opaqueSpans.some((span) => index >= span.startIndex && index <= span.endIndex)
                  ? " "
                  : char,
              )
              .join("");
            for (const discovery of [source, masked]) {
              expect(
                extractBalancedJsonFragments(discovery, {
                  recoverAtLineStart,
                  strictJson: { source, opaqueSpans },
                }),
              ).toEqual([
                {
                  json: after,
                  startIndex: source.length - after.length,
                  endIndex: source.length - 1,
                },
              ]);
            }
          }
        }
      }
    }
    for (const [child, prose] of [
      ['["text"]', ""],
      ['["text",]', ""],
      ['["text"]', '"prose [0] end" '],
      ['["text",]', '"prose [0] end" '],
    ]) {
      const prefix = "warning: [";
      const inside = '{"inside":0}';
      const source = `${prefix}${child}${inside}] ${prose}${after}`;
      for (const openers of [undefined, ["{"] as const]) {
        expect(
          extractBalancedJsonFragments(
            source.slice(0, prefix.length) + "  " + source.slice(prefix.length + 2),
            {
              openers,
              ...strictRecovery,
              strictJson: {
                source,
              },
            },
          ),
        ).toEqual(
          (openers ? [inside, after] : [after]).map((json) => ({
            json,
            startIndex: source.indexOf(json),
            endIndex: source.indexOf(json) + json.length - 1,
          })),
        );
      }
    }
  });

  it("keeps accepted framing from pushing or popping an active warning owner", () => {
    const records = ['{"after":1}', "[2]"];
    for (const [opener, closer] of [
      ["[", "]"],
      ["{", "}"],
    ]) {
      for (const framing of ["\u001b[31m", "\u001b]0;]} title\u0007"]) {
        for (const separator of [" ", "\n", "\r\n", "\r"]) {
          const prefix = `warning: ${opener}${framing}{"inside":0}${closer}${separator}`;
          const source = prefix + records.join("");
          const opaqueSpans = [{ startIndex: 10, endIndex: 9 + framing.length }];
          for (const discovery of [source, source.replace(framing, " ".repeat(framing.length))]) {
            for (const recoverAtLineStart of [false, true]) {
              expect(
                extractBalancedJsonFragments(discovery, {
                  recoverAtLineStart,
                  strictJson: { source, opaqueSpans },
                }),
              ).toEqual(
                records.map((json) => ({
                  json,
                  startIndex: source.indexOf(json),
                  endIndex: source.indexOf(json) + json.length - 1,
                })),
              );
            }
          }
        }
      }
    }
  });

  it("keeps accepted framing atomic before and after warning retirement", () => {
    const records = ['{"after":1}', "[2]"];
    for (const [opener, closer] of [
      ["[", "]"],
      ["{", "}"],
    ]) {
      for (const framing of [
        '\u001b]0;"title\u0007',
        '\u001b]0;"title"\u0007',
        '\u001b[1"q',
        'plain " frame',
        "plain frame",
      ]) {
        for (const [inner, prose] of [
          ["", ""],
          ['{"inside":0}', ""],
          ['"prose [0]"', ""],
          ["", '"prose [0] end" '],
          ['{"inside":0}', '"prose [0] end" '],
          ['"prose [0]"', '"prose [0] end" '],
        ]) {
          for (const separator of [" ", "\n", "\r\n", "\r"]) {
            const source = `warning: ${opener}${framing}${inner}${closer}${separator}${prose}${records.join("")}`;
            const opaqueSpans = [{ startIndex: 10, endIndex: 9 + framing.length }];
            for (const discovery of [source, source.replace(framing, " ".repeat(framing.length))]) {
              for (const recoverAtLineStart of [false, true]) {
                expect(
                  extractBalancedJsonFragments(discovery, {
                    recoverAtLineStart,
                    strictJson: { source, opaqueSpans },
                  }),
                ).toEqual(
                  records.map((json) => ({
                    json,
                    startIndex: source.lastIndexOf(json),
                    endIndex: source.lastIndexOf(json) + json.length - 1,
                  })),
                );
              }
            }
          }
        }
      }
    }
  });

  it("keeps consecutive accepted frames atomic across warning retirement and quoted prose", () => {
    const records = ['{"after":1}', "[2]"];
    for (const frames of [
      ['\u001b]0;"title\u0007', '\u001b]0;"title\u0007'],
      ['\u001b[1"q', '\u001b[1"q'],
      ['generic "\\ frame', '\u001b]0;"title\u0007'],
      ['generic "\n frame', "generic '\r\n frame"],
    ]) {
      for (const [opener, closer] of [
        ["[", "]"],
        ["{", "}"],
      ]) {
        for (const placement of ["inside", "across", "outside"]) {
          for (const separator of [" ", "\n", "\r\n", "\r"]) {
            let source = `warning: ${opener}${placement === "outside" ? "warning " : ""}`;
            const opaqueSpans: { startIndex: number; endIndex: number }[] = [];
            if (placement === "outside") {
              source += closer + separator;
            }
            for (const [index, frame] of frames.entries()) {
              opaqueSpans.push({
                startIndex: source.length,
                endIndex: source.length + frame.length - 1,
              });
              source += frame;
              if (placement === "across" && index === 0) {
                source += closer + separator;
              }
            }
            if (placement === "inside") {
              source += closer + separator;
            }
            source += '"prose [0] end" ' + records.join("");
            const masked = source
              .split("")
              .map((char, index) =>
                opaqueSpans.some((span) => index >= span.startIndex && index <= span.endIndex)
                  ? " "
                  : char,
              )
              .join("");
            for (const raw of [source, masked]) {
              for (const recoverAtLineStart of [false, true]) {
                for (const openers of [undefined, ["{"] as const]) {
                  expect(
                    extractBalancedJsonFragments(raw, {
                      openers,
                      recoverAtLineStart,
                      strictJson: { source, opaqueSpans },
                    }),
                  ).toEqual(
                    records
                      .filter((json) => !openers || json[0] === "{")
                      .map((json) => ({
                        json,
                        startIndex: source.lastIndexOf(json),
                        endIndex: source.lastIndexOf(json) + json.length - 1,
                      })),
                  );
                }
              }
            }
          }
        }
      }
    }
  });

  it("matches warning expiry with atomic framing and whitespace escape boundaries", () => {
    const after = '{"after":1}';
    for (const [opener, closer] of [
      ["[", "]"],
      ["{", "}"],
    ]) {
      for (const frame of [
        '\u009d0;"title\u0007',
        "\u009d0;xtitle\u0007",
        '\u001b]0;"title\\[]}\u0007',
        '\u001b]0;"title"\u0007',
        '\u001b[1"q',
        'generic "\\[]}',
      ]) {
        for (const newline of ["", "\n", "\r\n", "\r"]) {
          const framing = frame + newline;
          for (const escape of ["", "\\"]) {
            for (const closed of [false, true]) {
              const prefix = `warning: ${opener}${escape}`;
              const source =
                prefix + framing + ` "prose ${closer} end" ${closed ? closer : ""} ${after}`;
              const opaqueSpans = [
                { startIndex: prefix.length, endIndex: prefix.length + framing.length - 1 },
              ];
              const masked =
                prefix +
                framing.replace(/[^\r\n]/g, " ") +
                source.slice(prefix.length + framing.length);
              for (const raw of [source, masked]) {
                for (const recoverAtLineStart of [false, true]) {
                  for (const openers of [undefined, [opener as "{" | "["]]) {
                    expect(
                      extractBalancedJsonFragments(raw, {
                        openers,
                        recoverAtLineStart,
                        strictJson: { source, opaqueSpans },
                      }),
                      JSON.stringify({ source, openers, recoverAtLineStart }),
                    ).toEqual(
                      closed && (!openers || opener === "{")
                        ? [
                            {
                              json: after,
                              startIndex: source.length - after.length,
                              endIndex: source.length - 1,
                            },
                          ]
                        : [],
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("distinguishes atomic framing from a source-preserving discovery mask", () => {
    const source = '["a"]{}';
    for (const recoverAtLineStart of [false, true]) {
      expect(
        extractBalancedJsonFragments(source, {
          recoverAtLineStart,
          strictJson: {
            source,
            opaqueSpans: [
              { startIndex: 0, endIndex: 1 },
              { startIndex: 2, endIndex: 6 },
            ],
          },
        }),
      ).toEqual([]);
      expect(
        extractBalancedJsonFragments('  a"]{}', {
          recoverAtLineStart,
          strictJson: { source, opaqueSpans: [{ startIndex: 2, endIndex: 6 }] },
        }),
      ).toEqual([{ json: "{}", startIndex: 5, endIndex: 6 }]);
    }
  });

  it("protects native-valid children and restores their entry quote context", () => {
    for (const [opener, closer, after] of [
      ["[", "]", "[1]"],
      ["{", "}", '{"after":1}'],
    ] as const) {
      for (const newline of ["", "\n", "\r\n", "\r"]) {
        for (const child of [
          `[${newline}"x"${newline}]`,
          `[${newline}${JSON.stringify(closer.repeat(2))}${newline}]`,
          `{${newline}"x":${JSON.stringify(closer.repeat(2))}${newline}}`,
        ]) {
          const prefix = `warning: ${opener} broken `;
          const quotes = Array.from(child.matchAll(/"/g), ({ index }) => prefix.length + index);
          for (const maskedQuotes of [[], quotes.slice(0, 1), quotes]) {
            for (const hiddenEnd of [false, true]) {
              const opaqueSpans = [
                ...maskedQuotes,
                ...(hiddenEnd ? [prefix.length + child.length - 1] : []),
              ].map((index) => ({ startIndex: index, endIndex: index }));
              for (const closed of [false, true]) {
                const source =
                  prefix + child + ` "p ${closer} end" ${closed ? closer : ""} ${after}`;
                const masked = source
                  .split("")
                  .map((char, index) =>
                    opaqueSpans.some((span) => span.startIndex === index) ? " " : char,
                  )
                  .join("");
                for (const raw of [source, masked]) {
                  for (const recoverAtLineStart of [false, true]) {
                    for (const openers of [undefined, [opener as "{" | "["]]) {
                      expect(
                        extractBalancedJsonFragments(raw, {
                          openers,
                          recoverAtLineStart,
                          strictJson: { source, opaqueSpans },
                        }),
                        JSON.stringify({ source, opaqueSpans, openers, recoverAtLineStart }),
                      ).toEqual(
                        closed
                          ? [
                              {
                                json: after,
                                startIndex: source.length - after.length,
                                endIndex: source.length - 1,
                              },
                            ]
                          : [],
                      );
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("retires matcher context on every lexical exit before consuming its delimiter", () => {
    for (const [outer, end, after] of [
      ["[", "]", "[1]"],
      ["{", "}", '{"after":1}'],
    ] as const) {
      for (const [inner, close] of [
        ["[", "]"],
        ["{", "}"],
      ] as const) {
        for (const newline of ["\n", "\r\n", "\r"]) {
          const children = [
            `${inner}"unfinished${newline}${close}`,
            `${inner}"closed" invalid${close}`,
            `${inner}"unfinished${newline}${inner === "[" ? "{" : "["}broken${newline}${close}`,
            `${inner}"unfinished${newline}[broken]${newline}last line"${close}`,
            `${inner}${close}`,
          ];
          for (const child of children) {
            for (const closed of [false, true]) {
              for (const frame of ["", '\u001b]0;"title\u0007']) {
                const prefix = `warning: ${outer}${newline}${child}${newline}`;
                const source =
                  prefix + frame + `"expected ${end}${end} here" ${closed ? end : ""} ${after}`;
                const opaqueSpans = frame
                  ? [{ startIndex: prefix.length, endIndex: prefix.length + frame.length - 1 }]
                  : [];
                for (const openers of [undefined, [outer]]) {
                  const records = [
                    ...(child === `${inner}${close}` && (!openers || openers.includes(inner))
                      ? [child]
                      : []),
                    ...(closed ? [after] : []),
                  ];
                  for (const raw of [source, source.replaceAll('"', " ")]) {
                    expect(
                      extractBalancedJsonFragments(raw, {
                        openers,
                        recoverAtLineStart: true,
                        strictJson: { source, opaqueSpans },
                      }),
                      JSON.stringify({ source, openers }),
                    ).toEqual(
                      records.map((json) => ({
                        json,
                        startIndex: source.indexOf(json),
                        endIndex: source.indexOf(json) + json.length - 1,
                      })),
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("retains hidden quote provenance without requiring a container endpoint", () => {
    const after = '{"after":1}';
    for (const opener of ["[", "{"]) {
      for (const newline of ["\n", "\r\n", "\r"]) {
        const source = `${opener}"text"${newline}${after}`;
        const opaqueSpans = [{ startIndex: 3, endIndex: source.length - 1 }];
        for (const discovery of [source, source.replaceAll('"', " ")]) {
          for (const recoverAtLineStart of [false, true]) {
            expect(
              extractBalancedJsonFragments(discovery, {
                recoverAtLineStart,
                strictJson: { source, opaqueSpans },
              }),
            ).toEqual(
              recoverAtLineStart
                ? [{ json: after, startIndex: source.indexOf(after), endIndex: source.length - 1 }]
                : [],
            );
          }
        }
      }
    }
  });

  it("uses discovery for candidate starts and original source for completion", () => {
    const source = '[{}] {"next":1}';
    for (const discovery of [source, source.replace("]", " ")]) {
      for (const recoverAtLineStart of [false, true]) {
        for (const opaqueSpans of [[], [{ startIndex: 3, endIndex: 3 }]]) {
          const first = opaqueSpans.length ? "{}" : "[{}]";
          expect(
            extractBalancedJsonFragments(discovery, {
              recoverAtLineStart,
              strictJson: { source, opaqueSpans },
            }),
          ).toEqual(
            [first, '{"next":1}'].map((json) => ({
              json,
              startIndex: source.indexOf(json),
              endIndex: source.indexOf(json) + json.length - 1,
            })),
          );
        }
      }
    }
  });

  it("expires a closed warning contribution without retiring crossing or unfinished lexical owners", () => {
    const records = ['{"after":1}', "[2]"];
    for (const [opener, crossing] of [
      ["[", '{"]":1}'],
      ["{", '["}",1]'],
    ] as const) {
      for (const newline of ["\n", "\r\n", "\r"]) {
        for (const closeQuote of [false, true]) {
          const prefix = `${opener}"${newline}${crossing}${closeQuote ? ' "' : ""} `;
          const source = prefix + records.join("");
          for (const discovery of [source, source.replace(newline, " ".repeat(newline.length))]) {
            for (const openers of [undefined, ["{"] as const, ["["] as const]) {
              expect(
                extractBalancedJsonFragments(discovery, {
                  recoverAtLineStart: true,
                  openers,
                  strictJson: { source },
                }),
              ).toEqual(
                [crossing, ...(closeQuote ? records : [])]
                  .filter(
                    (json) => !openers || openers.some((candidate) => json.startsWith(candidate)),
                  )
                  .map((json) => ({
                    json,
                    startIndex: source.indexOf(json),
                    endIndex: source.indexOf(json) + json.length - 1,
                  })),
              );
            }
          }
        }
      }
    }
  });

  it("bounds original string work and actual deeply nested dangling-owner retirement", () => {
    for (const depth of [256, 1024, 4096]) {
      for (const kind of ["string", "dangling", "framed-dangling", "recovering-dangling"]) {
        const dangling = kind !== "string";
        const framing = kind === "framed-dangling" ? '\u009d0;"\\[]\u0007' : "";
        const parent =
          kind === "recovering-dangling"
            ? `warning: [\n["unfinished\n${"{".repeat(depth)}]\n"expected ]] here" ]`
            : dangling
              ? `warning: [${framing}${"{".repeat(depth)}]`
              : `[${JSON.stringify("[".repeat(depth))},{}]`;
        const suffix = '{"after":true}';
        const source = parent + (dangling ? "\n" : " ") + suffix;
        const stringEnd = parent.lastIndexOf('"');
        const push = Array.prototype.push;
        const pop = Array.prototype.pop;
        const parse = JSON.parse;
        // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the original receiver.
        const slice = String.prototype.slice;
        let pushes = 0;
        let pops = 0;
        let parsedUnits = 0;
        let copiedUnits = 0;
        // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
        Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
          pushes += items.length;
          return Reflect.apply(push, this, items);
        };
        // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
        Array.prototype.pop = function (this: unknown[]) {
          pops++;
          return Reflect.apply(pop, this, []);
        };
        JSON.parse = (text, reviver) => {
          parsedUnits += text.length;
          return parse(text, reviver);
        };
        // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
        String.prototype.slice = function (this: string, start, end) {
          const result = Reflect.apply(slice, this, [start, end]);
          copiedUnits += result.length;
          return result;
        };
        let result: ReturnType<typeof extractBalancedJsonFragments>;
        try {
          result = extractBalancedJsonFragments(source, {
            ...strictRecovery,
            strictJson: {
              source,
              opaqueSpans: dangling
                ? framing
                  ? [{ startIndex: 10, endIndex: 9 + framing.length }]
                  : []
                : [
                    { startIndex: 1, endIndex: 1 },
                    { startIndex: stringEnd, endIndex: stringEnd },
                  ],
            },
          });
        } finally {
          // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
          Array.prototype.push = push;
          // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
          Array.prototype.pop = pop;
          JSON.parse = parse;
          // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
          String.prototype.slice = slice;
        }
        expect(result).toEqual([
          ...(dangling ? [] : [{ json: parent, startIndex: 0, endIndex: parent.length - 1 }]),
          { json: suffix, startIndex: parent.length + 1, endIndex: source.length - 1 },
        ]);
        expect(parsedUnits).toBeLessThanOrEqual(2 * source.length + 2 * (depth + 3));
        expect(copiedUnits).toBeLessThanOrEqual(3 * source.length);
        expect(pushes).toBeLessThanOrEqual(10 * source.length);
        expect(pops).toBeLessThanOrEqual(4 * source.length);
        if (dangling) {
          expect(pops).toBeGreaterThanOrEqual(depth + 1);
        }
      }
    }
  });

  it("admits exact valid original parents despite closers exposed by opaque quotes", () => {
    for (const text of ["}", "prefix } suffix"]) {
      for (const newline of ["\n", "\r\n", "\r"]) {
        const child = '{"ok":true}';
        const source = `[${JSON.stringify(text)},${newline}${child}${newline}]`;
        const opaqueSpans = [
          { startIndex: 1, endIndex: 1 },
          { startIndex: text.length + 2, endIndex: text.length + 2 },
        ];
        expect(() => JSON.parse(source)).not.toThrow();
        const childFragment = {
          json: child,
          startIndex: source.indexOf(child),
          endIndex: source.indexOf(child) + child.length - 1,
        };
        for (const discovery of [source, source.replaceAll('"', " ")]) {
          for (const recoverAtLineStart of [false, true]) {
            const options = { recoverAtLineStart, strictJson: { source, opaqueSpans } };
            expect(extractBalancedJsonFragments(discovery, options)).toEqual([
              { json: source, startIndex: 0, endIndex: source.length - 1 },
            ]);
            expect(extractBalancedJsonFragments(discovery, { ...options, openers: ["{"] })).toEqual(
              [childFragment],
            );
          }
        }
        const invalid = source.replace(",", " INVALID,");
        expect(() => JSON.parse(invalid)).toThrow();
        expect(
          extractBalancedJsonFragments(invalid, {
            ...strictRecovery,
            strictJson: { source: invalid, opaqueSpans },
          }),
        ).toEqual([
          {
            json: child,
            startIndex: invalid.indexOf(child),
            endIndex: invalid.indexOf(child) + child.length - 1,
          },
        ]);
      }
    }
  });

  it("bounds aggregate original-source admission when framing exposes nested string interiors", () => {
    for (const depth of [256, 1024, 4096]) {
      for (const ending of ['"]'.repeat(depth), '"]'.repeat(depth - 1), "}".repeat(depth)]) {
        const source = '[{},"'.repeat(depth) + ending;
        const discovery = source.replaceAll('"', " ");
        const opaqueSpans = Array.from(source.matchAll(/"/g), ({ index }) => ({
          startIndex: index,
          endIndex: index,
        }));
        const openers = Array.from(source.matchAll(/[{[]/g)).length;
        const parse = JSON.parse;
        // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below supplies the original receiver.
        const slice = String.prototype.slice;
        const push = Array.prototype.push;
        let parsedUnits = 0;
        let copiedUnits = 0;
        let calls = 0;
        let nodeEdges = 0;
        const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          parsedUnits += text.length;
          calls++;
          return parse(text, reviver);
        });
        // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
        String.prototype.slice = function (this: string, start, end) {
          const result = Reflect.apply(slice, this, [start, end]);
          copiedUnits += result.length;
          return result;
        };
        // eslint-disable-next-line no-extend-native -- Count native work without recursively recording spy calls.
        Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
          for (const item of items) {
            if (item && typeof item === "object" && "children" in item && "start" in item) {
              nodeEdges++;
            }
          }
          return Reflect.apply(push, this, items);
        };
        let result: ReturnType<typeof extractBalancedJsonFragments>;
        try {
          result = extractBalancedJsonFragments(discovery, {
            ...strictRecovery,
            strictJson: { source, opaqueSpans },
          });
        } finally {
          // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
          String.prototype.slice = slice;
          // eslint-disable-next-line no-extend-native -- Restore synchronous work counters even if extraction fails.
          Array.prototype.push = push;
          spy.mockRestore();
        }
        expect(result).toEqual([]);
        expect(calls).toBeLessThanOrEqual(openers);
        expect(parsedUnits).toBeLessThanOrEqual(2 * source.length + 2 * openers);
        expect(copiedUnits).toBeLessThanOrEqual(2 * source.length);
        // Admission forests, discovery ownership and final selection each visit
        // a container a bounded number of times, including rejected ancestors.
        expect(nodeEdges).toBeLessThanOrEqual(6 * openers);
      }
    }
  });
});
