// src/palette.ts

const gray = {
  "020":"#fbfbfb",
  "040":"#f9f9f9",
  "060":"#f8f8f8",
  "080":"#f2f2f3",
  "100":"#eeeeef",
  "200":"#dbdbdd",
  "300":"#c6c6c8",
  "400":"#adadb1",
  "500":"#8E8E95",
  "600":"#84848A",
  "700":"#79797F",
  "800":"#6C6C71",
  "900":"#4A4A4E",
  "920":"#424245",
  "940":"#39393c",
  "960":"#2e2e30",
  "980":"#1F1F21",
  "1000":"#141415",
  "1020":"#0B0B0C",
  "1040":"#070707"
};

const red = {
  "050":"#ffedea",
  "100":"#ffdbd6",
  "200":"#ffb7ae",
  "300":"#ff9187",
  "400":"#ff6762",
  "500":"#ff2e3f",
  "600":"#d52c36",
  "700":"#ad292e",
  "800":"#862425",
  "900":"#611e1d",
  "950":"#3e1715"
};

const orange = {
  "050":"#fff3ea",
  "100":"#ffe8d5",
  "200":"#ffd1ab",
  "300":"#ffba82",
  "400":"#ffa359",
  "500":"#fe8c2c",
  "600":"#d47628",
  "700":"#ac6023",
  "800":"#854c1e",
  "900":"#603819",
  "950":"#3d2513"
};

const yellow = {
  "050": "#fff9ea",
  "100": "#fff4d5",
  "200": "#ffe9ab",
  "300": "#ffde80",
  "400": "#ffd452",
  "500": "#ffca00",
  "600": "#d5a910",
  "700": "#ac8816",
  "800": "#856a17",
  "900": "#604c16",
  "950": "#3d3112"
};

const green = {
  "050": "#edf9ed",
  "100": "#daf3db",
  "200": "#b4e7b7",
  "300": "#8cda94",
  "400": "#5ecc71",
  "500": "#0dbe4e",
  "600": "#199f43",
  "700": "#1d8138",
  "800": "#1d642e",
  "900": "#1b4923",
  "950": "#162f19"
};

const mint = {
  "050": "#edfaf7",
  "100": "#dbf5ef",
  "200": "#b7ebdf",
  "300": "#8fe0d0",
  "400": "#61d5c0",
  "500": "#00cab1",
  "600": "#16a994",
  "700": "#1d8978",
  "800": "#1e6a5e",
  "900": "#1c4d44",
  "950": "#16312c"
};

const teal = {
  "050": "#eef9fa",
  "100": "#ddf4f6",
  "200": "#b9e8ed",
  "300": "#92dde4",
  "400": "#64d1db",
  "500": "#00c5d2",
  "600": "#17a5af",
  "700": "#1e858e",
  "800": "#1f686e",
  "900": "#1d4b4f",
  "950": "#173033"
};

const cyan = {
  "050": "#eff9fe",
  "100": "#def2fc",
  "200": "#bce6f9",
  "300": "#96d9f6",
  "400": "#68cdf2",
  "500": "#08c0ef",
  "600": "#1ca1c7",
  "700": "#2182a1",
  "800": "#22657c",
  "900": "#1e4959",
  "950": "#182f38"
};

const blue = {
  "050": "#eff5ff",
  "100": "#dfebff",
  "200": "#bdd7ff",
  "300": "#97c4ff",
  "400": "#69b1ff",
  "500": "#009fff",
  "600": "#1a85d4",
  "700": "#216cab",
  "800": "#215584",
  "900": "#1f3e5e",
  "950": "#19283c"
};

const indigo = {
  "050": "#f5ecff",
  "100": "#ead9ff",
  "200": "#d3b4fe",
  "300": "#ba8ffd",
  "400": "#9d6afb",
  "500": "#7b43f8",
  "600": "#693acf",
  "700": "#5731a7",
  "800": "#462981",
  "900": "#35205c",
  "950": "#24173a"
};

const purple = {
  "050": "#fbedfd",
  "100": "#f7dbfb",
  "200": "#eeb6f6",
  "300": "#e290f0",
  "400": "#d568ea",
  "500": "#c635e4",
  "600": "#a631be",
  "700": "#872b9a",
  "800": "#692677",
  "900": "#4d1f56",
  "950": "#321736"
};

const pink = {
  "050": "#ffedf0",
  "100": "#ffdbe1",
  "200": "#ffb7c4",
  "300": "#ff91a8",
  "400": "#ff678d",
  "500": "#fc2b73",
  "600": "#d32a61",
  "700": "#aa2850",
  "800": "#84243f",
  "900": "#5f1e2f",
  "950": "#3d1720"
};

const brown = {
  "050": "#f8f2ee",
  "100": "#f1e4dd",
  "200": "#e3cabb",
  "300": "#d3b19b",
  "400": "#c3987b",
  "500": "#b27f5c",
  "600": "#956b4f",
  "700": "#7a5841",
  "800": "#5f4534",
  "900": "#453327",
  "950": "#2d221b"
};

export type Roles = {
  bg: {
    editor: string;    // main editor background (brightest in light, darkest in dark)
    window: string;    // sidebar, activity bar, status bar, title bar, inactive tabs
    inset: string;     // inputs, dropdowns
    elevated: string;  // panels, hover backgrounds
  };
  fg: { base: string; fg1: string; fg2: string; fg3: string; fg4: string };
  border: {
    window: string;           // borders for sidebar, activity bar, status bar, title bar
    editor: string;           // general editor borders
    indentGuide: string;      // indent guide lines
    indentGuideActive: string; // active indent guide line
    inset: string;            // borders for inputs, dropdowns
    elevated: string;         // borders for panels
  };
  accent: { primary: string; link: string; subtle: string; contrastOnAccent: string };
  states: { merge: string, success: string; danger: string; warn: string; info: string };
  syntax: {
    comment: string; string: string; number: string; keyword: string;
    regexp: string; func: string; type: string; variable: string;
    // Extended token types
    operator: string; punctuation: string; constant: string;
    parameter: string; namespace: string; decorator: string;
    escape: string; invalid: string; tag: string; attribute: string;
  };
  ansi: {
    black: string; red: string; green: string; yellow: string;
    blue: string; magenta: string; cyan: string; white: string;
    brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
    brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
  };
};

export const light: Roles = {
  bg: {
    editor: "#ffffff",
    window: gray["060"],
    inset: gray["080"],
    elevated: gray["040"]
  },
  fg: {
    base: gray["1040"],
    fg1: gray["900"],
    fg2: gray["800"],
    fg3: gray["600"],
    fg4: gray["500"]
  },
  border: {
    window: gray["100"],
    editor: gray["200"],
    indentGuide: gray["100"],
    indentGuideActive: gray["200"],
    inset: gray["200"],
    elevated: gray["100"]
  },
  accent: {
    primary: blue["500"],
    link: blue["500"],
    subtle: blue["100"],
    contrastOnAccent: "#ffffff"
  },
  states: {
    merge: indigo["500"],
    success: mint["500"],
    danger: red["500"],
    warn: yellow["500"],
    info: cyan["500"]
  },
  syntax: {
    comment: gray["600"],
    string: green["600"],
    number: cyan["600"],
    keyword: pink["500"],
    regexp: teal["600"],
    func: indigo["500"],
    type: purple["500"],
    variable: orange["600"],
    // Extended token types
    operator: cyan["500"],
    punctuation: gray["700"],
    constant: yellow["600"],
    parameter: gray["700"],
    namespace: yellow["600"],
    decorator: blue["500"],
    escape: cyan["600"],
    invalid: gray["1040"],
    tag: red["600"],
    attribute: mint["600"]
  },
  ansi: {
    black: gray["980"],
    red: red["500"],
    green: green["500"],
    yellow: yellow["500"],
    blue: blue["500"],
    magenta: purple["500"],
    cyan: cyan["500"],
    white: gray["300"],
    // make bright colors match the non-bright counterparts
    brightBlack: gray["980"],
    brightRed: red["500"],
    brightGreen: green["500"],
    brightYellow: yellow["500"],
    brightBlue: blue["500"],
    brightMagenta: purple["500"],
    brightCyan: cyan["500"],
    brightWhite: gray["300"]
  }
};

export const dark: Roles = {
  bg: {
    editor: gray["1040"],
    window: gray["1000"],
    inset: gray["980"],
    elevated: gray["1020"]
  },
  fg: {
    base: gray["020"],
    fg1: gray["200"],
    fg2: gray["400"],
    fg3: gray["600"],
    fg4: gray["700"]
  },
  border: {
    window: gray["1040"],
    editor: gray["980"],
    indentGuide: gray["980"],
    indentGuideActive: gray["960"],
    inset: gray["980"],
    elevated: gray["980"]
  },
  accent: {
    primary: blue["500"],
    link: blue["500"],
    subtle: blue["950"],
    contrastOnAccent: gray["1040"]
  },
  states: {
    merge: indigo["500"],
    success: mint["500"],
    danger: red["500"],
    warn: yellow["500"],
    info: cyan["500"]
  },
  syntax: {
    comment: gray["600"],
    string: green["400"],
    number: cyan["400"],
    keyword: pink["400"],
    regexp: teal["400"],
    func: indigo["400"],
    type: purple["400"],
    variable: orange["400"],
    // Extended token types
    operator: cyan["500"],
    punctuation: gray["700"],
    constant: yellow["400"],
    parameter: gray["400"],
    namespace: yellow["500"],
    decorator: blue["400"],
    escape: cyan["400"],
    invalid: gray["020"],
    tag: red["400"],
    attribute: mint["400"]
  },
  ansi: {
    black: gray["1000"],
    red: red["500"],
    green: green["500"],
    yellow: yellow["500"],
    blue: blue["500"],
    magenta: purple["500"],
    cyan: cyan["500"],
    white: gray["300"],
    brightBlack: gray["1000"],
    brightRed: red["500"],
    brightGreen: green["500"],
    brightYellow: yellow["500"],
    brightBlue: blue["500"],
    brightMagenta: purple["500"],
    brightCyan: cyan["500"],
    brightWhite: gray["300"]
  }
};
