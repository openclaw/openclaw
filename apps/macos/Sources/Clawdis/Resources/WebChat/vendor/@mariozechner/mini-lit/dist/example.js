import { html, render } from "lit";
import { CheckCircle, Moon, Send, Settings } from "lucide";
import { icon } from "./icons.js";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, createState, Input, Progress, Select, Separator, Switch, } from "./index.js";
import "./ThemeToggle.js";
import "./CodeBlock.js";
import "./MarkdownBlock.js";
// State for interactive components
const state = createState({
    checkbox1: false,
    checkbox2: true,
    switch1: false,
    switch2: true,
    progressValue: 33,
    selectedFruit: "apple",
    inputValue: "",
    count: 0,
});
const MiniLitDemo = () => html `
   <!-- Theme Toggle - Fixed Position -->
   <theme-toggle class="fixed top-4 right-4 z-50"></theme-toggle>

   <div class="min-h-screen p-8 bg-background text-foreground">
      <div class="max-w-6xl mx-auto space-y-12">
         <!-- Header -->
         <div class="text-center">
            <h1 class="text-5xl font-bold mb-4">mini-lit</h1>
            <p class="text-xl text-muted-foreground">Lightweight Lit components with shadcn-inspired theming</p>
         </div>

         <!-- Buttons Section -->
         <section class="space-y-6">
            <h2 class="text-3xl font-semibold">Buttons</h2>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">Variants</h3>
               <div class="flex flex-wrap gap-4">
                  ${Button({ children: "Default" })} ${Button({ variant: "secondary", children: "Secondary" })}
                  ${Button({ variant: "destructive", children: "Destructive" })}
                  ${Button({ variant: "outline", children: "Outline" })}
                  ${Button({ variant: "ghost", children: "Ghost" })} ${Button({ variant: "link", children: "Link" })}
               </div>
            </div>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">Sizes</h3>
               <div class="flex flex-wrap gap-4 items-center">
                  ${Button({ size: "sm", children: "Small" })} ${Button({ size: "md", children: "Medium" })}
                  ${Button({ size: "lg", children: "Large" })}
                  ${Button({ size: "icon", children: icon(Settings, "sm") })}
               </div>
            </div>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">States</h3>
               <div class="flex flex-wrap gap-4">
                  ${Button({ disabled: true, children: "Disabled" })}
                  ${Button({ loading: true, children: "Loading..." })}
               </div>
            </div>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">With Icons</h3>
               <div class="flex flex-wrap gap-4">
                  ${Button({
    children: html `
                        ${icon(Send, "sm")}
                        <span>Send Message</span>
                     `,
})}
                  ${Button({
    variant: "outline",
    size: "icon",
    children: icon(Moon, "sm"),
})}
               </div>
            </div>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">Interactive</h3>
               <div class="flex flex-wrap gap-4 items-center">
                  ${Button({
    onClick: () => {
        state.count++;
        renderDemo();
    },
    children: `Clicked ${state.count} times`,
})}
                  ${Button({
    variant: "secondary",
    onClick: () => alert("Hello from mini-lit!"),
    children: "Show Alert",
})}
               </div>
            </div>
         </section>

         ${Separator()}

         <!-- Cards Section -->
         <section class="space-y-6">
            <h2 class="text-3xl font-semibold">Cards</h2>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
               ${Card(html `
                  ${CardHeader(html ` ${CardTitle("Card Title")} ${CardDescription("Card description goes here")} `)}
                  ${CardContent(html ` <p>This is the card content. You can put any content here.</p> `)}
               `)}
               ${Card(html `
                  ${CardHeader(html ` ${CardTitle("Interactive Card")} ${CardDescription("Try the form below")} `)}
                  ${CardContent(html `
                     <div class="space-y-4">
                        ${Input({
    label: "Email",
    type: "email",
    placeholder: "[redacted-email]",
})}
                        ${Input({
    label: "Password",
    type: "password",
    placeholder: "Enter your password",
})}
                     </div>
                  `)}
                  ${CardFooter(html ` ${Button({ className: "w-full", children: "Sign In" })} `)}
               `)}
            </div>
         </section>

         ${Separator()}

         <!-- Form Controls Section -->
         <section class="space-y-6">
            <h2 class="text-3xl font-semibold">Form Controls</h2>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
               <div class="space-y-4">
                  <h3 class="text-lg font-medium text-muted-foreground">Inputs</h3>
                  ${Input({
    label: "Text Input",
    placeholder: "Enter text...",
    value: state.inputValue,
    onInput: (e) => {
        state.inputValue = e.target.value;
        renderDemo();
    },
})}
                  ${Input({
    label: "With Error",
    error: "This field is required",
    placeholder: "Error state",
})}
                  ${Input({
    label: "Disabled",
    disabled: true,
    placeholder: "Disabled input",
})}
               </div>

               <div class="space-y-4">
                  <h3 class="text-lg font-medium text-muted-foreground">Checkboxes & Switches</h3>
                  ${Checkbox(state.checkbox1, (checked) => {
    state.checkbox1 = checked;
    renderDemo();
}, "Accept terms and conditions")}
                  ${Checkbox(state.checkbox2, (checked) => {
    state.checkbox2 = checked;
    renderDemo();
}, "Send me promotional emails")}
                  <div class="mt-4">
                     ${Switch(state.switch1, (checked) => {
    state.switch1 = checked;
    renderDemo();
}, "Enable notifications")}
                  </div>
                  <div>
                     ${Switch(state.switch2, (checked) => {
    state.switch2 = checked;
    renderDemo();
}, "Dark mode")}
                  </div>
               </div>
            </div>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">Select</h3>
               <div class="flex gap-4 items-center">
                  ${Select({
    value: state.selectedFruit,
    placeholder: "Select a fruit",
    options: [
        { value: "apple", label: "Apple" },
        { value: "banana", label: "Banana" },
        { value: "orange", label: "Orange" },
        { value: "grape", label: "Grape" },
    ],
    onChange: (value) => {
        state.selectedFruit = value;
        renderDemo();
    },
})}
                  <span class="text-muted-foreground">Selected: ${state.selectedFruit}</span>
               </div>
            </div>
         </section>

         ${Separator()}

         <!-- Feedback Section -->
         <section class="space-y-6">
            <h2 class="text-3xl font-semibold">Feedback</h2>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">Badges</h3>
               <div class="flex flex-wrap gap-2">
                  ${Badge("Default")} ${Badge("Secondary", "secondary")} ${Badge("Destructive", "destructive")}
                  ${Badge("Outline", "outline")}
                  ${Badge(html `
                        ${icon(CheckCircle, "xs")}
                        <span>Verified</span>
                     `, "secondary")}
               </div>
            </div>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">Alerts</h3>
               ${Alert(html `
                  ${AlertTitle("Heads up!")} ${AlertDescription("You can add components to your app using the cli.")}
               `)}
               ${Alert(html ` ${AlertTitle("Error")} ${AlertDescription("Your session has expired. Please log in again.")} `, "destructive")}
            </div>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">Progress</h3>
               <div class="space-y-2">
                  ${Progress(33)} ${Progress(66)} ${Progress(100)}
                  <div class="mt-4">
                     <div class="flex justify-between text-sm text-muted-foreground mb-2">
                        <span>Interactive Progress</span>
                        <span>${state.progressValue}%</span>
                     </div>
                     ${Progress(state.progressValue)}
                     <div class="flex gap-2 mt-2">
                        ${Button({
    size: "sm",
    variant: "outline",
    onClick: () => {
        state.progressValue = Math.max(0, state.progressValue - 10);
        renderDemo();
    },
    children: "-10%",
})}
                        ${Button({
    size: "sm",
    variant: "outline",
    onClick: () => {
        state.progressValue = Math.min(100, state.progressValue + 10);
        renderDemo();
    },
    children: "+10%",
})}
                     </div>
                  </div>
               </div>
            </div>
         </section>

         ${Separator()}

         <!-- Code Examples Section -->
         <section class="space-y-6">
            <h2 class="text-3xl font-semibold">Code Examples</h2>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">CodeBlock Component</h3>
               <code-block
                  language="typescript"
                  code=${btoa(`import { Button, Card, createState } from '@mariozechner/mini-lit';

const state = createState({
  count: 0
});

const MyComponent = () => html\`
  \${Card(html\`
    <h2>Counter: \${state.count}</h2>
    \${Button({
      onClick: () => state.count++,
      children: "Increment"
    })}
  \`)}
\`;`)}
               ></code-block>
            </div>

            <div class="space-y-4">
               <h3 class="text-lg font-medium text-muted-foreground">MarkdownBlock Component</h3>
               <markdown-block
                  .content=${
// biome-ignore lint/suspicious/noTemplateCurlyInString: dunno
"# Markdown Support\n\nThis component supports **bold text**, *italic text*, and `inline code`.\n\n## Features\n\n- Lists with bullets\n- Code blocks with syntax highlighting\n- Tables support\n- Math equations: $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$\n\n```javascript\n// Code blocks are highlighted\nfunction hello(name) {\n  return `Hello, ${name}!`;\n}\n```\n\n| Feature | Support |\n|---------|---------|\n| Tables  | ✅      |\n| Math    | ✅      |\n| Code    | ✅      |"}
               ></markdown-block>
            </div>
         </section>
      </div>
   </div>
`;
// Render function
const renderDemo = () => {
    render(MiniLitDemo(), document.body);
};
// Initial render
renderDemo();
// Subscribe to state changes
state.__subscribe(renderDemo);
//# sourceMappingURL=example.js.map