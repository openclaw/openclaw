import { html } from "lit";
import { createComponent } from "./props.js";
// Test with a simple Card component
const cardDefinition = {
    variant: {
        type: "variant",
        options: ["default", "bordered", "elevated"],
        default: "default",
        description: "Card style variant",
    },
    padding: {
        type: "variant",
        options: ["none", "sm", "md", "lg"],
        default: "md",
        description: "Padding size",
    },
    title: {
        type: "value",
        default: "",
        description: "Card title",
    },
    children: {
        type: "value",
        default: undefined,
        description: "Card content",
    },
    onClick: {
        type: "function",
        default: undefined,
        description: "Click handler",
    },
};
const cardStyles = {
    base: "rounded-lg transition-all",
    variants: {
        variant: {
            default: "bg-white border border-gray-200",
            bordered: "bg-white border-2 border-gray-400",
            elevated: "bg-white shadow-lg",
        },
        padding: {
            none: "p-0",
            sm: "p-2",
            md: "p-4",
            lg: "p-8",
        },
    },
    compoundVariants: [
        {
            variant: "elevated",
            padding: "lg",
            className: "shadow-2xl",
        },
    ],
};
const renderCard = (props, variants) => {
    const { variant, padding, title, children, onClick } = props;
    return html `
      <div
         class=${variants({ variant, padding })}
         @click=${onClick}
      >
         ${title ? html `<h3 class="text-lg font-bold mb-2">${title}</h3>` : ""}
         ${children}
      </div>
   `;
};
export const Card = createComponent(cardDefinition, cardStyles, renderCard);
// Test usage
const testCard = Card({
    variant: "elevated",
    padding: "lg",
    title: "Test Card",
    children: html `<p>This is content</p>`,
});
console.log("Card component created successfully!");
//# sourceMappingURL=test-component.js.map