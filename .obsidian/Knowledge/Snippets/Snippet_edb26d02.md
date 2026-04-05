Task: Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь docstring и type hints.
Tags: #type #помощью #добавь #python #docstring

```python
def sieve_of_eratosthenes(n: int) -> list[int]:
    """
    Return a list of all prime numbers up to and including n using the Sieve of Eratosthenes.

    Parameters
    ----------
    n : int
        The upper bound (inclusive) for searching for primes. Must be >= 2.

    Returns
    -------
    list[int]
        A list containing all prime numbers less than or equal to n.

    Example
    -------
    >>> sieve_of_eratosthenes(10)
    [2, 3, 5, 7]
    """
    if n < 2:
        return []

    # Initialize a boolean array where index i indicates whether i is prime.
    sieve = [True] * (n + 1)
    sieve[0] = sieve[1] = False  # 0 and 1 are not prime.

    # Eliminate multiples of each prime starting from 2.
    for p in range(2, int(n ** 0.5) + 1):
        if sieve[p]:
            # Mark all multiples of p (starting at p*p) as non‑prime.
            for multiple in range(p * p, n + 1, p):
                sieve[multiple] = False

    # Extract the indices that remain marked as prime.
    return [i for i, is_prime in enumerate(sieve) if is_prime]
```
