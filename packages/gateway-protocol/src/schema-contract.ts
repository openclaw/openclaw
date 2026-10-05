/** Keep handwritten optional-property contracts when deriving JSON shapes from schemas. */
export type SchemaContract<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { [K in keyof T]: SchemaContract<T[K]> }
    : T extends object
      ? {
          [K in keyof T]: SchemaContract<
            string extends K
              ? T[K]
              : number extends K
                ? T[K]
                : symbol extends K
                  ? T[K]
                  : Pick<T, K> extends Required<Pick<T, K>>
                    ? T[K]
                    : Exclude<T[K], undefined>
          >;
        }
      : T;
