// Custom Command
// Greets the user by name.

module.exports = {
  name: "greet",
  description: "Greets the user by name.",
  run: (args) => {
    const name = args[0] || "there";
    console.log(`Hello, ${name}!`);
  },
};